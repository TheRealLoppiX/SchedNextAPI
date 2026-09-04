const express = require('express');

const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('../services/whatsapp/provider');
const validate = require('../middleware/validate');
const { baixaManualAssinaturaSchema, cobrarAgoraAssinaturaSchema } = require('../schemas');
const { permiteWhatsappBot } = require('../utils/limitesPlano');
const {
  obterOuCriarCobrancaCicloAtual,
  gerarCobrancaPix,
  enviarNotificacaoCobrancaPix,
  marcarEmDia
} = require('../services/cobrancaAssinatura');

const router = express.Router();

// Admin dá baixa manual na mensalidade do ciclo atual de um cliente assinante — pro caso do
// cliente pagar por fora (chave Pix da própria barbearia, dinheiro no balcão) ou pagar
// presencialmente a mensalidade atrasada. Como calcularValorComLimiteAssinante (ver
// utils/limitesAssinatura.js) lê status_assinatura direto do banco toda vez no fechamento de
// caixa, dar essa baixa ANTES de finalizar o checkout do atendimento do dia já libera o preço de
// assinante nesse mesmo atendimento — sem nenhuma lógica retroativa.
router.post('/admin/clientes/:id/assinatura/baixa-manual', validate(baixaManualAssinaturaSchema), async (req, res) => {
  const { forma_pagamento, observacoes } = req.body;
  const empresaId = req.empresaId;

  const { data: cliente } = await supabase
    .from('usuarios')
    .select('id, empresa_id, plano_id, assinante_desde')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!cliente || cliente.empresa_id !== empresaId) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!cliente.plano_id) return res.status(400).json({ error: 'Este cliente não tem um plano de assinatura vinculado.' });
  if (!cliente.assinante_desde) return res.status(400).json({ error: 'Este cliente ainda não tem um ciclo de assinatura iniciado.' });

  const { data: plano } = await supabase.from('planos_assinatura').select('id, preco').eq('id', cliente.plano_id).maybeSingle();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado.' });

  try {
    const cobranca = await obterOuCriarCobrancaCicloAtual({
      usuario: cliente,
      empresa: { id: empresaId },
      plano,
      formaPagamento: forma_pagamento
    });

    const { error: errUpdate } = await supabase
      .from('assinatura_cobrancas')
      .update({
        status: 'pago',
        forma_pagamento,
        baixado_manualmente: true,
        observacoes: observacoes || null,
        pago_em: new Date().toISOString()
      })
      .eq('id', cobranca.id);
    if (errUpdate) throw errUpdate;

    await marcarEmDia(cliente.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao dar baixa manual na assinatura:', err);
    res.status(500).json({ error: 'Não foi possível registrar a baixa agora.' });
  }
});

// Cobrança/lembrete sob demanda — usado quando a cobrança automática do ciclo falhou, ou pra
// CONFIGURAR a cobrança automática de Pix pela primeira vez direto pelo admin (o cliente também
// pode configurar sozinho pelo próprio perfil — ver POST /usuario/:id/assinatura-cobranca/assinar
// em routes/mercadopago.js). Cartão não pode ser configurado nem cobrado avulso pelo admin: o
// preapproval exige a autorização do próprio dono do cartão na página do Mercado Pago, e não
// aceita cobrança fora do ciclo já agendado — só reenvia um lembrete apontando pra tela de
// assinatura do cliente.
router.post('/admin/clientes/:id/assinatura/cobrar-agora', validate(cobrarAgoraAssinaturaSchema), async (req, res) => {
  const empresaId = req.empresaId;

  const { data: cliente } = await supabase
    .from('usuarios')
    .select('id, empresa_id, plano_id, nome_completo, email, telefone, assinante_desde, assinatura_forma_pagamento')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!cliente || cliente.empresa_id !== empresaId) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!cliente.plano_id) return res.status(400).json({ error: 'Este cliente não tem um plano de assinatura vinculado.' });

  // Ainda sem forma de cobrança configurada: só dá pra configurar Pix por aqui (cartão precisa
  // ser o próprio cliente autorizando no Mercado Pago, pelo perfil dele).
  const formaPagamento = cliente.assinatura_forma_pagamento || (req.body.forma_pagamento === 'pix' ? 'pix' : null);
  if (!formaPagamento) {
    return res.status(400).json({
      error: 'Este cliente não tem cobrança automática configurada. Envie forma_pagamento:"pix" pra configurar agora, ou peça pra ele configurar cartão pelo próprio perfil. Pra pagamento avulso/presencial, use a baixa manual.'
    });
  }

  const { data: empresa } = await supabase.from('empresas').select('id, nome, mercadopago_access_token, whatsapp_phone_number_id').eq('id', empresaId).maybeSingle();
  const { data: plano } = await supabase.from('planos_assinatura').select('id, nome, preco').eq('id', cliente.plano_id).maybeSingle();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado.' });

  try {
    if (formaPagamento === 'pix') {
      if (!empresa?.mercadopago_access_token) {
        return res.status(400).json({ error: 'Conecte o Mercado Pago antes de gerar uma cobrança Pix.' });
      }
      const { qr_code, qr_code_base64 } = await gerarCobrancaPix({ usuario: cliente, empresa, plano });
      await enviarNotificacaoCobrancaPix({ usuario: cliente, empresa, plano, qrCode: qr_code, qrCodeBase64: qr_code_base64 });
      if (!cliente.assinatura_forma_pagamento) {
        await supabase.from('usuarios').update({ assinatura_forma_pagamento: 'pix' }).eq('id', cliente.id);
      }
      return res.json({ success: true, forma_pagamento: 'pix', qr_code, qr_code_base64 });
    }

    if (cliente.email) {
      transporter.sendMail({
        to: cliente.email,
        subject: `Lembrete de mensalidade - ${empresa?.nome || 'SchedNext'}`,
        html: emailHtml({
          titulo: `Olá, ${cliente.nome_completo}!`,
          mensagemHtml: `
            <p style="margin: 0 0 4px;">Sua mensalidade do plano <strong>${plano.nome}</strong> na <strong>${empresa?.nome || 'barbearia'}</strong> está pendente.</p>
            <p style="margin: 12px 0;">Acesse sua área de cliente para conferir os dados de cobrança do cartão.</p>
          `
        })
      }).catch((err) => console.error('Erro ao enviar lembrete de mensalidade:', err));
    }
    if (cliente.telefone && empresa?.whatsapp_phone_number_id && (await permiteWhatsappBot(empresaId))) {
      enviarMensagem(
        empresa.whatsapp_phone_number_id,
        `55${cliente.telefone.replace(/\D/g, '')}`,
        `💈 Lembrete: sua mensalidade do plano ${plano.nome} na ${empresa.nome} está pendente. Confira os dados de cobrança do seu cartão.`
      ).catch((err) => console.error('Erro ao enviar WhatsApp de lembrete de mensalidade:', err));
    }
    res.json({ success: true, forma_pagamento: 'cartao', lembrete_enviado: true });
  } catch (err) {
    console.error('Erro ao cobrar assinatura agora:', err);
    res.status(500).json({ error: 'Não foi possível processar a cobrança agora.' });
  }
});

module.exports = router;
