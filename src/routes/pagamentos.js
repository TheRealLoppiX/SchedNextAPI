const express = require('express');
const supabase = require('../config/supabase');
const { estaConfigurado, criarCheckout } = require('../services/pagamento');

const router = express.Router();

const UM_MES_MS = 30 * 24 * 60 * 60 * 1000;

// Protegida pelo mesmo verificarTokenAdmin de toda a área /admin/* (ver server.js).
router.post('/admin/assinatura-plataforma/iniciar-upgrade', async (req, res) => {
  const empresaId = req.empresaId;
  const { plano_plataforma_id } = req.body;

  const { data: plano, error } = await supabase
    .from('planos_plataforma')
    .select('id, nome, preco_mensal')
    .eq('id', plano_plataforma_id)
    .maybeSingle();

  if (error || !plano) return res.status(400).json({ error: 'Plano inválido.' });

  // Trocar de plano sempre limpa qualquer cancelamento agendado anterior — o cliente está
  // ativamente escolhendo continuar (ou mudar), não faz sentido manter um downgrade pendente.
  const proximaCobranca = plano.preco_mensal > 0 ? new Date(Date.now() + UM_MES_MS).toISOString() : null;

  if (!estaConfigurado()) {
    // Sem gateway configurado ainda: já deixa a empresa marcada nesse plano em modo trial,
    // em vez de travar o upgrade esperando uma integração que não existe.
    await supabase.from('empresas').update({
      plano_plataforma_id: plano.id,
      status_assinatura: plano.preco_mensal > 0 ? 'trial' : 'ativa',
      proxima_cobranca_em: proximaCobranca,
      cancelamento_agendado: false
    }).eq('id', empresaId);
    return res.json({ configurado: false, message: 'Cobrança automática ainda não está disponível. Seu plano foi atualizado em modo de teste.' });
  }

  try {
    const checkout = await criarCheckout({ empresaId, planoId: plano.id, planoNome: plano.nome, precoMensal: plano.preco_mensal });
    res.json(checkout);
  } catch (e) {
    console.error('Erro ao iniciar checkout:', e);
    res.status(500).json({ error: 'Não foi possível iniciar a cobrança agora. Tente novamente mais tarde.' });
  }
});

// Cancela a COBRANÇA — o plano atual continua ativo até proxima_cobranca_em, e só nessa
// data (processado pelo cron em src/cron/assinaturas.js) a conta cai pro plano Grátis.
router.post('/admin/assinatura-plataforma/cancelar-cobranca', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: empresa } = await supabase
    .from('empresas')
    .select('proxima_cobranca_em, plano_plataforma:plano_plataforma_id(preco_mensal)')
    .eq('id', empresaId)
    .maybeSingle();

  if (!empresa?.proxima_cobranca_em || !(empresa.plano_plataforma?.preco_mensal > 0)) {
    return res.status(400).json({ error: 'Esta conta não tem uma cobrança recorrente ativa para cancelar.' });
  }

  await supabase.from('empresas').update({ cancelamento_agendado: true }).eq('id', empresaId);
  res.json({ message: `Cobrança cancelada. Seu plano continua ativo até ${new Date(empresa.proxima_cobranca_em).toLocaleDateString('pt-BR')}, quando a conta passa pro plano Grátis automaticamente.` });
});

// Desfaz o cancelamento agendado — a cobrança volta a acontecer normalmente na data prevista.
router.post('/admin/assinatura-plataforma/reativar-cobranca', async (req, res) => {
  const empresaId = req.empresaId;
  await supabase.from('empresas').update({ cancelamento_agendado: false }).eq('id', empresaId);
  res.json({ message: 'Cobrança reativada — seu plano continua normalmente.' });
});

// Cancela o PLANO imediatamente (sem reembolso) — diferente de cancelar a cobrança, aqui a
// conta já cai pro Grátis na hora, mesmo que reste tempo pago no ciclo atual.
router.post('/admin/assinatura-plataforma/cancelar-plano', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: planoGratis } = await supabase.from('planos_plataforma').select('id').eq('nome', 'Grátis').maybeSingle();
  if (!planoGratis) return res.status(500).json({ error: 'Erro interno ao localizar o plano Grátis.' });

  const { error } = await supabase
    .from('empresas')
    .update({
      plano_plataforma_id: planoGratis.id,
      status_assinatura: 'ativa',
      proxima_cobranca_em: null,
      cancelamento_agendado: false
    })
    .eq('id', empresaId);

  if (error) return res.status(500).json({ error: 'Erro ao cancelar o plano.' });
  res.json({ message: 'Plano cancelado imediatamente. Você já está no plano Grátis — sem reembolso do período restante.' });
});

// Webhook do gateway de pagamento — formato genérico por enquanto (empresa_id + status);
// quando o gateway real for escolhido, adaptar o parsing do payload aqui, sem mudar o resto.
// IMPORTANTE: sem gateway real ainda não há assinatura/segredo pra validar a origem da
// chamada — antes de aceitar tráfego de produção, adicionar aqui a verificação de assinatura
// do gateway escolhido (todo webhook de pagamento sério manda uma), senão qualquer um pode
// chamar essa rota e forjar status de assinatura.
router.post('/pagamentos/webhook', async (req, res) => {
  const { empresa_id, status_assinatura, gateway_customer_id } = req.body;

  if (!empresa_id || !status_assinatura) return res.status(400).json({ error: 'Payload inválido.' });
  if (!['trial', 'ativa', 'inadimplente', 'cancelada'].includes(status_assinatura)) {
    return res.status(400).json({ error: 'status_assinatura inválido.' });
  }

  const atualizacao = { status_assinatura };
  if (gateway_customer_id) atualizacao.gateway_customer_id = gateway_customer_id;

  const { error } = await supabase.from('empresas').update(atualizacao).eq('id', empresa_id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar status da assinatura.' });

  res.json({ recebido: true });
});

module.exports = router;
