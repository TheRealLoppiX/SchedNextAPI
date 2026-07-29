const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('./whatsapp/provider');
const { permiteWhatsappBot } = require('../utils/limitesPlano');

// Chamado depois de um checkout ser concluído (ver routes/agendamentos.js,
// POST /admin/finalizar-servico-checkout). Antes disso o cliente só descobria que bateu a meta
// da campanha de fidelidade se abrisse a tela dele mesmo (GET /fidelidade/:userId calculava sob
// demanda) — aqui a gente detecta e avisa automaticamente, uma única vez por campanha.
async function verificarEDispararPremioFidelidade(usuarioId, empresaId) {
  if (!usuarioId) return;

  try {
    const { data: campanha } = await supabase
      .from('campanhas_fidelidade')
      .select('*')
      .eq('empresa_id', empresaId)
      .eq('ativa', true)
      .limit(1)
      .maybeSingle();

    if (!campanha) return;

    // Já notificado pra essa campanha? Não manda de novo (UNIQUE(usuario_id, campanha_id)
    // garante isso mesmo sob corrida de duas requisições simultâneas).
    const { data: jaNotificado } = await supabase
      .from('fidelidade_premios_notificados')
      .select('id')
      .eq('usuario_id', usuarioId)
      .eq('campanha_id', campanha.id)
      .maybeSingle();
    if (jaNotificado) return;

    // Mesma contagem de elegibilidade usada em GET /fidelidade/:userId (routes/perfil.js) —
    // manter as duas em sincronia se essa regra mudar.
    const { count } = await supabase
      .from('agendamentos')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('status', 'concluido')
      .gte('data_hora', `${campanha.data_inicio}T00:00:00`)
      .lte('data_hora', `${campanha.data_fim}T23:59:59`)
      .gte('valor_total', campanha.valor_minimo);

    if ((count || 0) < campanha.cortes_necessarios) return;

    const { data: inserido } = await supabase
      .from('fidelidade_premios_notificados')
      .insert({ usuario_id: usuarioId, campanha_id: campanha.id })
      .select('id')
      .maybeSingle();
    // Se o insert não "pegou" (conflito de UNIQUE — outra requisição chegou primeiro), não manda.
    if (!inserido) return;

    const { data: usuario } = await supabase
      .from('usuarios')
      .select('nome_completo, email, telefone')
      .eq('id', usuarioId)
      .maybeSingle();
    if (!usuario) return;

    const { data: empresa } = await supabase.from('empresas').select('nome').eq('id', empresaId).maybeSingle();
    const nomeEmpresa = empresa?.nome || 'Seu estabelecimento';
    const primeiroNome = (usuario.nome_completo || '').split(' ')[0] || 'Cliente';
    const textoPremio = campanha.premio_descritivo || 'seu prêmio';

    if (usuario.email) {
      await transporter.sendMail({
        to: usuario.email,
        subject: `Parabéns, ${primeiroNome}! Você ganhou ${textoPremio}`,
        html: emailHtml({
          titulo: `Parabéns, ${primeiroNome}! 🎉`,
          mensagemHtml: `
            <p style="margin: 0 0 4px;">Você completou a campanha <strong>${campanha.nome}</strong> da <strong>${nomeEmpresa}</strong>!</p>
            <p style="margin: 12px 0;">Seu prêmio: <strong>${textoPremio}</strong>. Aproveite no seu próximo atendimento.</p>
          `
        })
      });
    }

    if (usuario.telefone && (await permiteWhatsappBot(empresaId))) {
      await enviarMensagem(
        `55${usuario.telefone.replace(/\D/g, '')}`,
        `Parabéns, ${primeiroNome}! Você completou a campanha "${campanha.nome}" da ${nomeEmpresa} e ganhou ${textoPremio}. Aproveite no seu próximo atendimento!`
      );
    }
  } catch (err) {
    console.error('Erro ao verificar/disparar prêmio de fidelidade:', err);
  }
}

module.exports = { verificarEDispararPremioFidelidade };
