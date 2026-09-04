const express = require('express');

const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('../services/whatsapp/provider');
const validate = require('../middleware/validate');
const { baixaManualAssinaturaSchema } = require('../schemas');
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

// Gera (ou regenera) uma cobrança Pix real no Mercado Pago pro ciclo atual do cliente e manda
// por e-mail/WhatsApp — usável a qualquer momento (primeiro pagamento, tentativa que falhou,
// reforço) independente de o cliente já ter ou não cobrança automática configurada. De propósito
// SEPARADO de ativar-recorrente abaixo: gerar um Pix cobra o ciclo de agora; ativar decide se os
// PRÓXIMOS ciclos vão gerar cobrança sozinhos — são decisões distintas, não uma consequência da
// outra.
router.post('/admin/clientes/:id/assinatura/gerar-pix', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: cliente } = await supabase
    .from('usuarios')
    .select('id, empresa_id, plano_id, nome_completo, email, telefone, assinante_desde')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!cliente || cliente.empresa_id !== empresaId) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!cliente.plano_id) return res.status(400).json({ error: 'Este cliente não tem um plano de assinatura vinculado. Vincule e salve antes de gerar a cobrança.' });
  if (!cliente.assinante_desde) return res.status(400).json({ error: 'Este cliente ainda não tem um ciclo de assinatura iniciado. Salve o plano vinculado antes de gerar a cobrança.' });

  const { data: empresa } = await supabase.from('empresas').select('id, nome, mercadopago_access_token, whatsapp_phone_number_id').eq('id', empresaId).maybeSingle();
  if (!empresa?.mercadopago_access_token) {
    return res.status(400).json({ error: 'Conecte o Mercado Pago antes de gerar uma cobrança Pix.' });
  }
  const { data: plano } = await supabase.from('planos_assinatura').select('id, nome, preco').eq('id', cliente.plano_id).maybeSingle();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado.' });

  try {
    const { qr_code, qr_code_base64 } = await gerarCobrancaPix({ usuario: cliente, empresa, plano });
    await enviarNotificacaoCobrancaPix({ usuario: cliente, empresa, plano, qrCode: qr_code, qrCodeBase64: qr_code_base64 });
    res.json({ success: true, qr_code, qr_code_base64 });
  } catch (err) {
    console.error('Erro ao gerar Pix da assinatura:', err);
    res.status(500).json({ error: 'Não foi possível gerar o Pix agora. Tente novamente em instantes.' });
  }
});

// Liga a cobrança automática dos PRÓXIMOS ciclos (cron/cobrancaAssinaturas.js) — não gera
// cobrança nenhuma agora (ver gerar-pix acima pra isso). Só Pix pode ser ativado por aqui: o
// cliente já autoriza a cobrança avulsa passivamente (é o próprio Pix gerado a cada ciclo);
// cartão exige o dono do cartão autorizando o preapproval na página do Mercado Pago, então só o
// próprio cliente configura, pelo perfil dele.
router.post('/admin/clientes/:id/assinatura/ativar-recorrente', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: cliente } = await supabase
    .from('usuarios')
    .select('id, empresa_id, plano_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!cliente || cliente.empresa_id !== empresaId) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!cliente.plano_id) return res.status(400).json({ error: 'Este cliente não tem um plano de assinatura vinculado. Vincule e salve antes de ativar a cobrança automática.' });

  const { error } = await supabase.from('usuarios').update({ assinatura_forma_pagamento: 'pix' }).eq('id', cliente.id);
  if (error) return res.status(500).json({ error: 'Não foi possível ativar a cobrança automática agora.' });
  res.json({ success: true });
});

// Cobrança de cartão já configurada não aceita reforço avulso fora do ciclo (limitação do
// preapproval do Mercado Pago) — só reenvia um lembrete apontando pra tela de assinatura do
// cliente. Pra Pix, use gerar-pix acima (gera de verdade, não só lembra).
router.post('/admin/clientes/:id/assinatura/cobrar-agora', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: cliente } = await supabase
    .from('usuarios')
    .select('id, empresa_id, plano_id, nome_completo, email, telefone, assinatura_forma_pagamento')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!cliente || cliente.empresa_id !== empresaId) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!cliente.plano_id) return res.status(400).json({ error: 'Este cliente não tem um plano de assinatura vinculado.' });
  if (cliente.assinatura_forma_pagamento !== 'cartao') {
    return res.status(400).json({ error: 'Este lembrete é só para cobrança de cartão configurada. Pra Pix, use "Gerar Pix agora".' });
  }

  const { data: empresa } = await supabase.from('empresas').select('id, nome, whatsapp_phone_number_id').eq('id', empresaId).maybeSingle();
  const { data: plano } = await supabase.from('planos_assinatura').select('id, nome, preco').eq('id', cliente.plano_id).maybeSingle();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado.' });

  try {
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
