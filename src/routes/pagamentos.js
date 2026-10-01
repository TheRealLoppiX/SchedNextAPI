const express = require('express');
const supabase = require('../config/supabase');
const {
  estaConfigurado,
  criarCheckout,
  cancelarAssinaturaNoGateway,
  reativarAssinaturaNoGateway,
  criarPixAssinaturaPlataforma
} = require('../services/pagamento');
const { buscarCampanhaParaNovoCadastro, precoDoCiclo } = require('../services/precificacaoPlataforma');
const validate = require('../middleware/validate');
const { buscarPagamento } = require('../services/mercadopago');
const { iniciarUpgradeSchema } = require('../schemas');

const router = express.Router();

// Protegida pelo mesmo verificarTokenAdmin de toda a área /admin/* (ver server.js).
// Plano exclusivo oferecido a esta empresa pelo admin absoluto, no mesmo formato de
// GET /planos-plataforma (com a campanha, se houver), pra tela Conta listar junto dos públicos.
// Sob /admin/assinatura-plataforma/ pra continuar acessível com o teste grátis expirado.
router.get('/admin/assinatura-plataforma/plano-exclusivo', async (req, res) => {
  const { data: plano } = await supabase
    .from('planos_plataforma')
    .select('*')
    .eq('empresa_exclusiva_id', req.empresaId)
    .eq('ativo', true)
    .maybeSingle();
  if (!plano) return res.json(null);

  const { data: campanha } = await supabase
    .from('campanhas_precificacao')
    .select('nome, campanha_precos_ciclo(numero_ciclo, valor)')
    .eq('plano_plataforma_id', plano.id)
    .eq('ativa', true)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  res.json({
    ...plano,
    exclusivo: true,
    campanha: campanha ? {
      nome: campanha.nome,
      precos_por_ciclo: (campanha.campanha_precos_ciclo || [])
        .map((x) => ({ numero_ciclo: x.numero_ciclo, valor: Number(x.valor) }))
        .sort((a, b) => a.numero_ciclo - b.numero_ciclo)
    } : null
  });
});

// Cobrança da plataforma em aberto (contratação de plano enviada pelo admin ou iniciada pela
// empresa, ou mensalidade não paga), pro aviso no painel e pra tela Conta mostrarem o Pix. O QR
// vem do Mercado Pago na hora; Pix expirado volta sem QR e a tela oferece gerar outro.
async function cobrancaEmAberto(empresaId) {
  const { data: cobranca } = await supabase
    .from('plataforma_cobrancas')
    .select('id, serie, ciclo_ref, valor, status, mercadopago_payment_id, plano_plataforma_id, criado_em, origem')
    .eq('empresa_id', empresaId)
    .in('status', ['pendente', 'inadimplente'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();
  return cobranca || null;
}

router.get('/admin/assinatura-plataforma/cobranca-pendente', async (req, res) => {
  const cobranca = await cobrancaEmAberto(req.empresaId);
  if (!cobranca) return res.json(null);

  const { data: empresa } = await supabase
    .from('empresas')
    .select('plano_plataforma_pendente_id, plano_plataforma:plano_plataforma_id(nome)')
    .eq('id', req.empresaId)
    .maybeSingle();
  const contratacao = cobranca.ciclo_ref <= 1 && (cobranca.plano_plataforma_id || empresa?.plano_plataforma_pendente_id);
  let planoNome = empresa?.plano_plataforma?.nome || '';
  if (contratacao) {
    const { data: planoNovo } = await supabase.from('planos_plataforma').select('nome').eq('id', cobranca.plano_plataforma_id || empresa.plano_plataforma_pendente_id).maybeSingle();
    planoNome = planoNovo?.nome || planoNome;
  }

  let qr = { qr_code: null, qr_code_base64: null };
  if (cobranca.mercadopago_payment_id && process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN) {
    try {
      const pagamento = await buscarPagamento({ accessTokenVendedor: process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN, paymentId: cobranca.mercadopago_payment_id });
      if (pagamento.status === 'pending') {
        qr = {
          qr_code: pagamento.point_of_interaction?.transaction_data?.qr_code || null,
          qr_code_base64: pagamento.point_of_interaction?.transaction_data?.qr_code_base64 || null
        };
      }
    } catch (err) {
      console.error('Erro ao buscar o Pix da cobrança pendente da plataforma:', err.message || err);
    }
  }

  res.json({
    id: cobranca.id,
    tipo: contratacao ? 'contratacao' : 'mensalidade',
    plano_nome: planoNome,
    plano_plataforma_id: contratacao ? (cobranca.plano_plataforma_id || empresa.plano_plataforma_pendente_id) : null,
    valor: Number(cobranca.valor),
    status: cobranca.status,
    criado_em: cobranca.criado_em,
    ...qr
  });
});

// Pix novo pra mesma cobrança em aberto (o anterior expirou). Mesma série/ciclo/valor, só troca o
// pagamento no Mercado Pago; o webhook acha a cobrança pelo id novo.
router.post('/admin/assinatura-plataforma/cobranca-pendente/pix', async (req, res) => {
  const cobranca = await cobrancaEmAberto(req.empresaId);
  if (!cobranca) return res.status(404).json({ error: 'Não há cobrança em aberto.' });

  const { data: empresa } = await supabase.from('empresas').select('email, plano_plataforma:plano_plataforma_id(nome)').eq('id', req.empresaId).maybeSingle();
  try {
    const pix = await criarPixAssinaturaPlataforma({
      empresaId: req.empresaId,
      planoNome: empresa?.plano_plataforma?.nome || 'SchedNext',
      valor: Number(cobranca.valor),
      email: empresa?.email,
      cicloRef: cobranca.ciclo_ref
    });
    if (!pix.configurado) return res.status(503).json({ error: pix.message });
    await supabase.from('plataforma_cobrancas')
      .update({ mercadopago_payment_id: pix.mercadopagoPaymentId, status: 'pendente', criado_em: new Date().toISOString() })
      .eq('id', cobranca.id);
    res.json({ qr_code: pix.qr_code, qr_code_base64: pix.qr_code_base64, valor: Number(cobranca.valor) });
  } catch (err) {
    console.error('Erro ao gerar novo Pix da cobrança pendente da plataforma:', err);
    res.status(500).json({ error: 'Não foi possível gerar o Pix agora. Tente novamente em instantes.' });
  }
});

router.post('/admin/assinatura-plataforma/iniciar-upgrade', validate(iniciarUpgradeSchema), async (req, res) => {
  const empresaId = req.empresaId;
  const { plano_plataforma_id, forma_pagamento } = req.body;

  const { data: plano, error } = await supabase
    .from('planos_plataforma')
    .select('id, nome, preco_mensal, ativo, publico, empresa_exclusiva_id')
    .eq('id', plano_plataforma_id)
    .maybeSingle();

  if (error || !plano) return res.status(400).json({ error: 'Plano inválido.' });

  // Plano desligado/oculto (área de teste do admin absoluto) não é contratável pelo próprio
  // cliente — só o admin absoluto aplica. Sem isso, um plano de R$0 com todos os recursos
  // criado só pra testar cairia no branch "preco <= 0" abaixo e seria ativado de graça.
  // Exceção: o plano exclusivo que o admin absoluto montou pra esta empresa (ver
  // superAdminPlataforma.js), contratável só por ela.
  const exclusivoDestaEmpresa = plano.empresa_exclusiva_id != null && String(plano.empresa_exclusiva_id) === String(empresaId);
  if (!plano.ativo || (!plano.publico && !exclusivoDestaEmpresa)) return res.status(400).json({ error: 'Este plano não está disponível no momento.' });

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
    .select('email, gateway_subscription_id, plataforma_serie')
    .eq('id', empresaId)
    .maybeSingle();

  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
  // Nova contratação = série nova de cobranças (ver sql/2026_cobranca_obrigatoria_plataforma.sql):
  // os ciclos do plano novo recomeçam do 1 sem bater nos do plano anterior. A recorrência antiga
  // é cancelada logo abaixo, então a série já passa a ser a da empresa.
  const serie = (empresa.plataforma_serie || 0) + 1;

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
      gateway_subscription_id: null,
      campanha_precificacao_id: null,
      ciclo_cobranca_atual: 1,
      plataforma_forma_pagamento: null
    }).eq('id', empresaId);
    return res.json({ configurado: true, message: 'Plano atualizado para o Grátis.' });
  }

  // Campanha promocional pro plano escolhido, se houver uma em vigor agora (ver
  // services/precificacaoPlataforma.js) — o 1º ciclo já nasce no preço promocional; os
  // seguintes são ajustados no cartão (routes/mercadopago.js:processarNotificacaoAssinatura) ou
  // já nascem certos no Pix (cron/cobrancaPlataforma.js), ciclo a ciclo.
  const campanha = await buscarCampanhaParaNovoCadastro(plano.id);
  const precoPrimeiroCiclo = precoDoCiclo(campanha, 1, plano.preco_mensal);

  if (forma_pagamento === 'pix') {
    try {
      const cobranca = await criarPixAssinaturaPlataforma({
        empresaId,
        planoNome: plano.nome,
        valor: precoPrimeiroCiclo,
        email: empresa.email,
        cicloRef: 1
      });
      if (!cobranca.configurado) return res.status(503).json({ error: cobranca.message });

      // Contratação anterior ainda em aberto deixa de valer: só a mais recente ativa plano.
      await supabase.from('plataforma_cobrancas').update({ status: 'cancelada' }).eq('empresa_id', empresaId).eq('status', 'pendente').eq('ciclo_ref', 1);
      const { error: errCobranca } = await supabase.from('plataforma_cobrancas').insert({
        empresa_id: empresaId,
        serie,
        ciclo_ref: 1,
        valor: precoPrimeiroCiclo,
        forma_pagamento: 'pix',
        mercadopago_payment_id: cobranca.mercadopagoPaymentId,
        status: 'pendente',
        plano_plataforma_id: plano.id,
        campanha_precificacao_id: campanha?.id || null,
        origem: 'empresa'
      });
      // Sem a linha o webhook não acha o pagamento e o plano nunca ativa: melhor falhar aqui.
      if (errCobranca) throw errCobranca;

      // Mesmo princípio do cartão: plano_plataforma_id só troca de verdade quando o Pix cair
      // (webhook de payment, ver routes/mercadopago.js). gateway_subscription_id fica null —
      // Pix não tem recorrência no Mercado Pago, cada ciclo é uma cobrança avulsa nova.
      await supabase.from('empresas').update({
        plano_plataforma_pendente_id: plano.id,
        gateway_subscription_id: null,
        cancelamento_agendado: false,
        campanha_precificacao_id: campanha?.id || null,
        ciclo_cobranca_atual: 1,
        plataforma_forma_pagamento: 'pix',
        plataforma_serie: serie
      }).eq('id', empresaId);

      res.json({
        configurado: true,
        formaPagamento: 'pix',
        qr_code: cobranca.qr_code,
        qr_code_base64: cobranca.qr_code_base64,
        planoPendenteId: plano.id,
        message: 'Pague o Pix abaixo para ativar o plano.'
      });
    } catch (e) {
      console.error('Erro ao gerar Pix da assinatura da plataforma:', e);
      res.status(500).json({ error: 'Não foi possível gerar a cobrança Pix agora. Tente novamente mais tarde.' });
    }
    return;
  }

  try {
    const checkout = await criarCheckout({
      empresaId,
      planoNome: plano.nome,
      precoMensal: precoPrimeiroCiclo,
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
      cancelamento_agendado: false,
      campanha_precificacao_id: campanha?.id || null,
      ciclo_cobranca_atual: 1,
      plataforma_forma_pagamento: 'cartao',
      plataforma_serie: serie
    }).eq('id', empresaId);

    res.json({ ...checkout, planoPendenteId: plano.id });
  } catch (e) {
    console.error('Erro ao iniciar checkout:', e);
    res.status(500).json({ error: 'Não foi possível iniciar a cobrança agora. Tente novamente mais tarde.' });
  }
});

// Cancela a COBRANÇA. O plano atual continua ativo até o dia anterior a proxima_cobranca_em, e
// nessa data (processado pelo cron em src/cron/assinaturas.js) a conta cai pro plano Grátis. No
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
  // Usa até o dia anterior ao vencimento; no dia do vencimento o cron (src/cron/assinaturas.js) passa pro Grátis.
  const acessoAte = new Date(new Date(empresa.proxima_cobranca_em).getTime() - 24 * 60 * 60 * 1000)
    .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  res.json({ message: `Cobrança cancelada. Seu plano continua ativo até ${acessoAte}. Depois disso, a conta passa pro plano Grátis automaticamente.` });
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
