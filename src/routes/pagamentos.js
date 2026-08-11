const express = require('express');
const supabase = require('../config/supabase');
const { estaConfigurado, criarCheckout, cancelarAssinaturaNoGateway, reativarAssinaturaNoGateway } = require('../services/pagamento');
const validate = require('../middleware/validate');
const { iniciarUpgradeSchema } = require('../schemas');

const router = express.Router();

// Protegida pelo mesmo verificarTokenAdmin de toda a área /admin/* (ver server.js).
router.post('/admin/assinatura-plataforma/iniciar-upgrade', validate(iniciarUpgradeSchema), async (req, res) => {
  const empresaId = req.empresaId;
  const { plano_plataforma_id } = req.body;

  const { data: plano, error } = await supabase
    .from('planos_plataforma')
    .select('id, nome, preco_mensal')
    .eq('id', plano_plataforma_id)
    .maybeSingle();

  if (error || !plano) return res.status(400).json({ error: 'Plano inválido.' });

  // Enterprise (e qualquer plano futuro "sob consulta") não tem preço fixo — preco_mensal vem
  // null do banco. Sem essa checagem, `null <= 0` é true em JS e cairia no branch de downgrade
  // pro Grátis logo abaixo, ativando o plano de graça e pra sempre sem nenhuma cobrança real.
  // Esses planos passam pelo formulário de contato (POST /admin/empresa/contato-enterprise),
  // não por aqui.
  if (plano.preco_mensal === null) {
    return res.status(400).json({
      error: 'O plano Enterprise não tem valor fixo. Preencha o formulário de contato para negociar com nosso time.',
      requerContatoEnterprise: true
    });
  }

  const { data: empresa } = await supabase
    .from('empresas')
    .select('email, gateway_subscription_id')
    .eq('id', empresaId)
    .maybeSingle();

  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  // Sem gateway configurado (MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN ausente): não há como cobrar
  // de verdade, então não faz sentido fingir uma assinatura — recusa em vez de liberar o plano
  // pago de graça.
  if (!estaConfigurado()) {
    return res.status(503).json({ error: 'Cobrança automática não está disponível no momento. Fale com o suporte.' });
  }

  // Se já existe uma assinatura ativa no gateway (troca de plano pago pra outro plano, ou pro
  // Grátis), ela é cancelada antes — cada plano pago vira uma assinatura nova, com o valor
  // certo, em vez de tentar "editar" o valor da que já existe.
  if (empresa.gateway_subscription_id) {
    try {
      await cancelarAssinaturaNoGateway(empresa.gateway_subscription_id);
    } catch (e) {
      console.error('Erro ao cancelar assinatura anterior no Mercado Pago:', e);
    }
  }

  if (plano.preco_mensal <= 0) {
    // Downgrade pro Grátis: não depende de pagamento nenhum, então aplica na hora. Limpa
    // qualquer plano pendente de pagamento anterior — se havia uma cobrança em aberto, ela
    // acabou de ser cancelada no gateway acima, então não deve mais valer.
    await supabase.from('empresas').update({
      plano_plataforma_id: plano.id,
      plano_plataforma_pendente_id: null,
      status_assinatura: 'ativa',
      proxima_cobranca_em: null,
      cancelamento_agendado: false,
      gateway_subscription_id: null
    }).eq('id', empresaId);
    return res.json({ configurado: true, message: 'Plano atualizado para o Grátis.' });
  }

  try {
    const checkout = await criarCheckout({
      empresaId,
      planoNome: plano.nome,
      precoMensal: plano.preco_mensal,
      email: empresa.email
    });

    // IMPORTANTE: plano_plataforma_id (o plano de verdade em uso, que libera os recursos
    // gated — ver utils/limitesPlano.js) só é trocado pelo webhook quando o Mercado Pago
    // confirmar a autorização/pagamento (ver POST /webhooks/mercadopago em routes/mercadopago.js).
    // Até lá, a empresa continua com todos os recursos do plano ATUAL, e o plano escolhido fica
    // só registrado como pendente — sem isso, qualquer um conseguia liberar um plano pago só
    // clicando em "trocar", sem nunca pagar.
    await supabase.from('empresas').update({
      plano_plataforma_pendente_id: plano.id,
      gateway_subscription_id: checkout.gatewaySubscriptionId,
      cancelamento_agendado: false
    }).eq('id', empresaId);

    res.json({ ...checkout, planoPendenteId: plano.id });
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
    console.error('Erro ao cancelar assinatura no Mercado Pago:', e);
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
    .select('email, proxima_cobranca_em, plano_plataforma:plano_plataforma_id(nome, preco_mensal)')
    .eq('id', empresaId)
    .maybeSingle();

  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  try {
    const novoSubscriptionId = await reativarAssinaturaNoGateway({
      empresaId,
      email: empresa.email,
      planoNome: empresa.plano_plataforma?.nome,
      precoMensal: empresa.plano_plataforma?.preco_mensal,
      proximaCobrancaEm: empresa.proxima_cobranca_em
    });

    await supabase.from('empresas').update({
      cancelamento_agendado: false,
      ...(novoSubscriptionId ? { gateway_subscription_id: novoSubscriptionId } : {})
    }).eq('id', empresaId);
  } catch (e) {
    console.error('Erro ao reativar assinatura no Mercado Pago:', e);
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
    console.error('Erro ao cancelar assinatura no Mercado Pago:', e);
    // Não bloqueia o downgrade local por causa disso — pior cenário é uma cobrança a mais
    // que precisa ser estornada manualmente, melhor que travar o cliente no plano pago.
  }

  const { error } = await supabase
    .from('empresas')
    .update({
      plano_plataforma_id: planoGratis.id,
      plano_plataforma_pendente_id: null,
      status_assinatura: 'ativa',
      proxima_cobranca_em: null,
      cancelamento_agendado: false,
      gateway_subscription_id: null
    })
    .eq('id', empresaId);

  if (error) return res.status(500).json({ error: 'Erro ao cancelar o plano.' });
  res.json({ message: 'Plano cancelado imediatamente. Você já está no plano Grátis, sem reembolso do período restante.' });
});

// O webhook de confirmação de pagamento/assinatura agora é o do Mercado Pago (unificado com o
// do Pix avulso) — ver POST /webhooks/mercadopago em routes/mercadopago.js.

module.exports = router;
