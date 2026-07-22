const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { estaConfigurado, criarCheckout, cancelarAssinaturaNoGateway, reativarAssinaturaNoGateway } = require('../services/pagamento');
const asaas = require('../services/asaas');
const validate = require('../middleware/validate');
const { iniciarUpgradeSchema } = require('../schemas');

const router = express.Router();

const UM_MES_MS = 30 * 24 * 60 * 60 * 1000;

// Protegida pelo mesmo verificarTokenAdmin de toda a área /admin/* (ver server.js).
router.post('/admin/assinatura-plataforma/iniciar-upgrade', validate(iniciarUpgradeSchema), async (req, res) => {
  const empresaId = req.empresaId;
  const { plano_plataforma_id, cpf_cnpj } = req.body;

  const { data: plano, error } = await supabase
    .from('planos_plataforma')
    .select('id, nome, preco_mensal')
    .eq('id', plano_plataforma_id)
    .maybeSingle();

  if (error || !plano) return res.status(400).json({ error: 'Plano inválido.' });

  const { data: empresa } = await supabase
    .from('empresas')
    .select('nome, email, cpf_cnpj, gateway_customer_id, gateway_subscription_id')
    .eq('id', empresaId)
    .maybeSingle();

  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  // Trocar de plano sempre limpa qualquer cancelamento agendado anterior. O cliente está
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

  // Se já existe uma assinatura ativa no gateway (troca de plano pago pra outro plano, ou pro
  // Grátis), ela é cancelada antes — cada plano pago vira uma assinatura nova, com o valor
  // certo, em vez de tentar "editar" o valor da que já existe.
  if (empresa.gateway_subscription_id) {
    try {
      await cancelarAssinaturaNoGateway(empresa.gateway_subscription_id);
    } catch (e) {
      console.error('Erro ao cancelar assinatura anterior no Asaas:', e);
    }
  }

  if (plano.preco_mensal <= 0) {
    // Downgrade pro Grátis: só cancela a cobrança recorrente, sem criar nada novo.
    await supabase.from('empresas').update({
      plano_plataforma_id: plano.id,
      status_assinatura: 'ativa',
      proxima_cobranca_em: null,
      cancelamento_agendado: false,
      gateway_subscription_id: null
    }).eq('id', empresaId);
    return res.json({ configurado: true, message: 'Plano atualizado para o Grátis.' });
  }

  const documento = cpf_cnpj || empresa.cpf_cnpj;
  if (!documento) {
    return res.status(400).json({ error: 'Informe seu CPF ou CNPJ para assinar um plano pago.', requerDocumento: true });
  }

  try {
    const checkout = await criarCheckout({
      empresaId,
      planoNome: plano.nome,
      precoMensal: plano.preco_mensal,
      nomeEmpresa: empresa.nome,
      email: empresa.email,
      cpfCnpj: documento,
      gatewayCustomerIdExistente: empresa.gateway_customer_id
    });

    await supabase.from('empresas').update({
      plano_plataforma_id: plano.id,
      cpf_cnpj: documento,
      gateway_customer_id: checkout.gatewayCustomerId,
      gateway_subscription_id: checkout.gatewaySubscriptionId,
      status_assinatura: 'trial', // vira 'ativa' quando o webhook confirmar o primeiro pagamento
      proxima_cobranca_em: proximaCobranca,
      cancelamento_agendado: false
    }).eq('id', empresaId);

    res.json(checkout);
  } catch (e) {
    console.error('Erro ao iniciar checkout:', e);
    res.status(500).json({ error: 'Não foi possível iniciar a cobrança agora. Tente novamente mais tarde.' });
  }
});

// Cancela a COBRANÇA. O plano atual continua ativo até proxima_cobranca_em, e só nessa
// data (processado pelo cron em src/cron/assinaturas.js) a conta cai pro plano Grátis. No
// gateway, a assinatura é cancelada JÁ (impede a próxima cobrança) — o acesso continuar até a
// data prometida é só um controle local, não depende de nenhuma cobrança futura acontecer.
router.post('/admin/assinatura-plataforma/cancelar-cobranca', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: empresa } = await supabase
    .from('empresas')
    .select('proxima_cobranca_em, gateway_subscription_id, plano_plataforma:plano_plataforma_id(preco_mensal)')
    .eq('id', empresaId)
    .maybeSingle();

  if (!empresa?.proxima_cobranca_em || !(empresa.plano_plataforma?.preco_mensal > 0)) {
    return res.status(400).json({ error: 'Esta conta não tem uma cobrança recorrente ativa para cancelar.' });
  }

  try {
    await cancelarAssinaturaNoGateway(empresa.gateway_subscription_id);
  } catch (e) {
    console.error('Erro ao cancelar assinatura no Asaas:', e);
    return res.status(500).json({ error: 'Não foi possível cancelar a cobrança agora. Tente novamente mais tarde.' });
  }

  await supabase.from('empresas').update({ cancelamento_agendado: true }).eq('id', empresaId);
  res.json({ message: `Cobrança cancelada. Seu plano continua ativo até ${new Date(empresa.proxima_cobranca_em).toLocaleDateString('pt-BR')}, quando a conta passa pro plano Grátis automaticamente.` });
});

// Desfaz o cancelamento agendado. Recria a assinatura no gateway com a mesma data de próxima
// cobrança já prometida ao cliente (ver cancelar-cobranca acima, que tinha cancelado de vez).
router.post('/admin/assinatura-plataforma/reativar-cobranca', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: empresa } = await supabase
    .from('empresas')
    .select('proxima_cobranca_em, gateway_customer_id, plano_plataforma:plano_plataforma_id(nome, preco_mensal)')
    .eq('id', empresaId)
    .maybeSingle();

  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  try {
    const novoSubscriptionId = await reativarAssinaturaNoGateway({
      empresaId,
      gatewayCustomerId: empresa.gateway_customer_id,
      planoNome: empresa.plano_plataforma?.nome,
      precoMensal: empresa.plano_plataforma?.preco_mensal,
      proximaCobrancaEm: empresa.proxima_cobranca_em
    });

    await supabase.from('empresas').update({
      cancelamento_agendado: false,
      ...(novoSubscriptionId ? { gateway_subscription_id: novoSubscriptionId } : {})
    }).eq('id', empresaId);
  } catch (e) {
    console.error('Erro ao reativar assinatura no Asaas:', e);
    return res.status(500).json({ error: 'Não foi possível reativar a cobrança agora. Tente novamente mais tarde.' });
  }

  res.json({ message: 'Cobrança reativada. Seu plano continua normalmente.' });
});

// Cancela o PLANO imediatamente (sem reembolso). Diferente de cancelar a cobrança, aqui a
// conta já cai pro Grátis na hora, mesmo que reste tempo pago no ciclo atual.
router.post('/admin/assinatura-plataforma/cancelar-plano', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: planoGratis } = await supabase.from('planos_plataforma').select('id').eq('nome', 'Grátis').maybeSingle();
  if (!planoGratis) return res.status(500).json({ error: 'Erro interno ao localizar o plano Grátis.' });

  const { data: empresaAtual } = await supabase.from('empresas').select('gateway_subscription_id').eq('id', empresaId).maybeSingle();

  try {
    await cancelarAssinaturaNoGateway(empresaAtual?.gateway_subscription_id);
  } catch (e) {
    console.error('Erro ao cancelar assinatura no Asaas:', e);
    // Não bloqueia o downgrade local por causa disso — pior cenário é uma cobrança a mais
    // que precisa ser estornada manualmente, melhor que travar o cliente no plano pago.
  }

  const { error } = await supabase
    .from('empresas')
    .update({
      plano_plataforma_id: planoGratis.id,
      status_assinatura: 'ativa',
      proxima_cobranca_em: null,
      cancelamento_agendado: false,
      gateway_subscription_id: null
    })
    .eq('id', empresaId);

  if (error) return res.status(500).json({ error: 'Erro ao cancelar o plano.' });
  res.json({ message: 'Plano cancelado imediatamente. Você já está no plano Grátis, sem reembolso do período restante.' });
});

// Webhook do Asaas. Autenticado pelo token que você configura no painel deles (Integrações →
// Webhooks → "Token de autenticação"), reenviado em todo POST no header `asaas-access-token`.
// Sem ASAAS_WEBHOOK_TOKEN definido, a rota recusa toda chamada (fail-closed) em vez de aceitar
// sem validar nada.
router.post('/pagamentos/webhook', async (req, res) => {
  const segredoEsperado = process.env.ASAAS_WEBHOOK_TOKEN;
  const segredoRecebido = req.headers['asaas-access-token'];

  if (!segredoEsperado) {
    console.error('ASAAS_WEBHOOK_TOKEN não configurado, recusando webhook de pagamento.');
    return res.status(503).json({ error: 'Webhook de pagamento não configurado.' });
  }

  const bufEsperado = Buffer.from(segredoEsperado);
  const bufRecebido = Buffer.from(String(segredoRecebido || ''));
  const valido = bufEsperado.length === bufRecebido.length && crypto.timingSafeEqual(bufEsperado, bufRecebido);

  if (!valido) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const { event, payment } = req.body || {};
  if (!event || !payment?.customer) return res.status(400).json({ error: 'Payload inválido.' });

  const EVENTOS_ATIVA = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
  const EVENTOS_INADIMPLENTE = ['PAYMENT_OVERDUE'];

  if (!EVENTOS_ATIVA.includes(event) && !EVENTOS_INADIMPLENTE.includes(event)) {
    return res.json({ recebido: true, ignorado: true });
  }

  const { data: empresa } = await supabase
    .from('empresas')
    .select('id')
    .eq('gateway_customer_id', payment.customer)
    .maybeSingle();

  if (!empresa) return res.json({ recebido: true, empresaNaoEncontrada: true });

  const atualizacao = { status_assinatura: EVENTOS_ATIVA.includes(event) ? 'ativa' : 'inadimplente' };

  // No pagamento confirmado, busca a data real da próxima cobrança na assinatura (o Asaas já
  // avançou o ciclo) em vez de recalcular localmente — evita desalinhar com o que o Asaas vai
  // efetivamente cobrar.
  if (EVENTOS_ATIVA.includes(event) && payment.subscription) {
    try {
      const assinatura = await asaas.buscarAssinatura(payment.subscription);
      if (assinatura?.nextDueDate) atualizacao.proxima_cobranca_em = new Date(assinatura.nextDueDate).toISOString();
    } catch (e) {
      console.error('Erro ao buscar próxima cobrança no Asaas:', e);
    }
  }

  const { error } = await supabase.from('empresas').update(atualizacao).eq('id', empresa.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar status da assinatura.' });

  res.json({ recebido: true });
});

module.exports = router;
