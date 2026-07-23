const cron = require('node-cron');
const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('../services/whatsapp/provider');

// América/São_Paulo é sempre UTC-3 (sem horário de verão desde 2019). O banco guarda data_hora
// como "horário de parede pretendido, rotulado como UTC": um agendamento às 09:00
// (horário local) é gravado como "09:00:00+00", sem conversão real de fuso (mesma convenção do
// MySQL original, que usava DATETIME ingênuo). Isso significa que comparar esse valor direto
// contra um Date() de verdade (que representa o instante real) fica errado por 3h. É preciso
// converter explicitamente nos dois sentidos.
const OFFSET_BRASILIA_MS = 3 * 60 * 60 * 1000;

// Converte o instante real (ex: "agora") para a mesma convenção "ingênua" usada no banco,
// para poder comparar direto nas queries.
function paraConvencaoDoBanco(instanteReal) {
  return new Date(instanteReal.getTime() - OFFSET_BRASILIA_MS);
}

// Converte um data_hora do banco (convenção ingênua) para o instante real correspondente.
function paraInstanteReal(dataHoraDoBanco) {
  return new Date(new Date(dataHoraDoBanco).getTime() + OFFSET_BRASILIA_MS);
}

function iniciarLembretes() {
  cron.schedule('*/1 * * * *', async () => {
    console.log('Verificando lembretes de agendamentos próximos...');

    const agora = new Date();
    const limite = new Date(agora.getTime() + 75 * 60000); // +1h15min

    const { data: agendamentos, error } = await supabase
      .from('agendamentos')
      .select('id, data_hora, usuario_id, usuarios!inner(email, nome_completo, telefone), barbeiros!inner(nome), empresas!inner(plano_plataforma:plano_plataforma_id(permite_whatsapp_bot))')
      .gte('data_hora', paraConvencaoDoBanco(agora).toISOString())
      .lte('data_hora', paraConvencaoDoBanco(limite).toISOString())
      .neq('status', 'cancelado')
      .eq('lembrete_1h_enviado', false);

    if (error) return console.error('Erro no SQL do Cron:', error);

    for (const ag of agendamentos || []) {
      try {
        const dataAgendamentoBanco = new Date(ag.data_hora);
        const instanteReal = paraInstanteReal(ag.data_hora);
        const diffMilissegundos = instanteReal - agora;
        const minutosFaltando = Math.round(diffMilissegundos / 60000);

        // Se por algum motivo o cron rodar e o tempo já passou (atraso), ignoramos ou ajustamos
        if (minutosFaltando < -5) continue;

        const tempoTexto = minutosFaltando <= 0 ? 'poucos minutos' : `${minutosFaltando} minutos`;
        // Os números gravados já são o horário de parede certo. Usar os getters UTC (não
        // toLocaleTimeString) pra não converter de fuso de novo.
        const horaFmt = `${String(dataAgendamentoBanco.getUTCHours()).padStart(2, '0')}:${String(dataAgendamentoBanco.getUTCMinutes()).padStart(2, '0')}`;

        const msg = `Ei ${ag.usuarios.nome_completo}, falta apenas ${tempoTexto} para o seu horário com ${ag.barbeiros.nome} (${horaFmt}). Já estamos te esperando!`;

        // ENVIAR EMAIL
        await transporter.sendMail({
          to: ag.usuarios.email,
          subject: `Seu horário é daqui a ${tempoTexto}! - SchedNext`,
          html: emailHtml({ titulo: `Olá, ${ag.usuarios.nome_completo}!`, mensagemHtml: `<p style="margin: 0;">${msg}</p>` })
        });

        // ENVIAR WHATSAPP (só para empresas no plano com o bot habilitado, ver planos_plataforma)
        if (ag.empresas?.plano_plataforma?.permite_whatsapp_bot && ag.usuarios.telefone) {
          await enviarMensagem(ag.usuarios.telefone, msg);
        }

        // ATUALIZAR STATUS PARA NÃO REPETIR
        await supabase.from('agendamentos').update({ lembrete_1h_enviado: true }).eq('id', ag.id);

        // NOTIFICAÇÃO NO APP
        await supabase.from('notificacoes').insert({ usuario_id: ag.usuario_id, titulo: 'Seu horário está próximo!', mensagem: msg });

        console.log(`Lembrete de ${minutosFaltando} min enviado para: ${ag.usuarios.email}`);
      } catch (err) {
        console.error('Erro no envio do lembrete:', err);
      }
    }
  });
}

module.exports = iniciarLembretes;
