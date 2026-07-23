const cron = require('node-cron');
const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('../services/whatsapp/provider');
const { paraConvencaoDoBanco, paraInstanteReal } = require('../utils/horarioBrasilia');

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
          // usuarios.telefone é salvo sem DDI (ver utils/telefone.js) — diferente do fluxo do
          // bot (services/whatsapp/bot.js), onde o telefone já vem com DDI direto do WhatsApp.
          // Sem prefixar o 55 aqui, o Evolution API recebia um número de 10-11 dígitos e a
          // mensagem nunca era entregue.
          await enviarMensagem(`55${ag.usuarios.telefone.replace(/\D/g, '')}`, msg);
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
