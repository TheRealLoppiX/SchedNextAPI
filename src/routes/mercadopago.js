const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const verificarTokenCliente = require('../middleware/clienteAuth');
const { mercadoPagoPixSchema } = require('../schemas');
const { obterTaxaMarketplace } = require('../utils/limitesPlano');
const { calcularValorFinalCheckout } = require('../services/pagamentoAgendamento');
const {
  montarUrlAutorizacao,
  trocarCodigoPorToken,
  criarPagamentoPix,
  buscarPagamento,
  criarPreapproval,
  cancelarPreapproval,
  buscarPreapproval,
  buscarPagamentoAutorizado
} = require('../services/mercadopago');

const router = express.Router();

// Modelo "vendedor conectado" (ver services/mercadopago.js): cada empresa autoriza a aplicação
// da SchedNext no Mercado Pago via OAuth, e a cobrança de cada Pix passa a sair com o
// access_token DELA — o dinheiro cai direto na conta da empresa, com a nossa fatia
// (application_fee) descontada automaticamente. Sem MERCADOPAGO_CLIENT_ID/SECRET configurados,
// a integração fica "não configurada" e nenhuma rota de conectar funciona (mesmo padrão de
// degradação graciosa já usado no Asaas e na Evolution API).
function estaConfigurado() {
  return Boolean(process.env.MERCADOPAGO_CLIENT_ID && process.env.MERCADOPAGO_CLIENT_SECRET);
}

// BACKEND_URL é a fonte preferida (mesma variável usada pro webhook do WhatsApp), mas cai pro
// host de quem chamou a rota se ela vier vazia por qualquer motivo — sem isso, a URL de
// redirect virava literalmente "undefined/mercadopago/oauth/callback" e o Mercado Pago recusava
// a autorização com um erro genérico, sem citar a causa.
function redirectUriCallback(req) {
  const base = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/mercadopago/oauth/callback`;
}

// Reconfirma um Pix pendente direto na API do Mercado Pago (nunca confia em status já gravado
// localmente além de 'pago', que é terminal) e persiste se tiver sido aprovado. Compartilhado
// pelas rotas de status (admin e cliente) e pelo webhook — as três precisam do mesmo
// comportamento de "sempre rebuscar antes de confiar".
async function reconfirmarPagamento({ agendamentoId, accessTokenVendedor, paymentId, statusAtual }) {
  if (statusAtual === 'pago' || !accessTokenVendedor) return statusAtual;

  try {
    const pagamento = await buscarPagamento({ accessTokenVendedor, paymentId });
    if (pagamento.status === 'approved') {
      await supabase.from('agendamentos').update({ pagamento_status: 'pago' }).eq('id', agendamentoId);
      return 'pago';
    }
  } catch (err) {
    console.error('Erro ao reconfirmar pagamento Pix:', err);
  }
  return statusAtual;
}

router.get('/admin/mercadopago', async (req, res) => {
  const empresa_id = req.empresaId;

  const { data: empresa, error } = await supabase
    .from('empresas')
    .select('mercadopago_access_token')
    .eq('id', empresa_id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar configuração do Mercado Pago.' });

  const taxa = await obterTaxaMarketplace(empresa_id);
  res.json({ configurado: estaConfigurado(), conectado: !!empresa?.mercadopago_access_token, taxa_marketplace_percentual: taxa });
});

// Devolve a URL de autorização pro frontend redirecionar o navegador — não dá pra redirecionar
// direto daqui porque o JWT de admin vive no localStorage do frontend (Authorization header),
// não em cookie, então uma navegação de página inteira não carrega esse header. O `state`
// carrega o empresaId de forma assinada (mesmo segredo do login de admin) pra identificar quem
// está conectando quando o Mercado Pago chamar o callback de volta.
router.get('/admin/mercadopago/link-conectar', async (req, res) => {
  if (!estaConfigurado()) {
    return res.status(503).json({ error: 'Integração com Mercado Pago não está disponível no momento.' });
  }

  const state = jwt.sign({ empresaId: req.empresaId }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const url = montarUrlAutorizacao({ redirectUri: redirectUriCallback(req), state });
  res.json({ url });
});

router.post('/admin/mercadopago/desconectar', async (req, res) => {
  const { error } = await supabase
    .from('empresas')
    .update({
      mercadopago_access_token: null,
      mercadopago_refresh_token: null,
      mercadopago_user_id: null,
      mercadopago_token_expira_em: null
    })
    .eq('id', req.empresaId);

  // Não tenta revogar o token no Mercado Pago — só limpa do nosso lado, mesmo padrão de
  // fallback já usado no DELETE /admin/whatsapp.
  if (error) return res.status(500).json({ error: 'Erro ao desconectar do Mercado Pago.' });
  res.json({ success: true });
});

// Gera a cobrança Pix pro atendimento em andamento no PDV. Usa a MESMA fórmula de valor final
// da rota /admin/finalizar-servico-checkout (ver services/pagamentoAgendamento.js) — precisam
// bater exatamente, senão o Pix cobra um valor e o fechamento de caixa registra outro.
router.post('/admin/mercadopago/pix/:agendamentoId', validate(mercadoPagoPixSchema), async (req, res) => {
  const { produtos_vendidos, servicos_adicionais } = req.body;
  const empresa_id = req.empresaId;

  const { data: empresa, error: empErr } = await supabase
    .from('empresas')
    .select('nome, mercadopago_access_token')
    .eq('id', empresa_id)
    .maybeSingle();
  if (empErr) return res.status(500).json({ error: 'Erro ao buscar empresa.' });
  if (!empresa?.mercadopago_access_token) {
    return res.status(400).json({ error: 'Conecte sua conta Mercado Pago antes de gerar um Pix.' });
  }

  try {
    const resultado = await calcularValorFinalCheckout({
      agendamentoId: req.params.agendamentoId,
      empresaId: empresa_id,
      produtosVendidos: produtos_vendidos,
      servicosAdicionais: servicos_adicionais
    });
    if (!resultado) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    if (!(resultado.valorFinal > 0)) {
      return res.status(400).json({ error: 'Não há valor a cobrar para este atendimento.' });
    }

    const taxaPercentual = await obterTaxaMarketplace(empresa_id);
    const cobranca = await criarPagamentoPix({
      accessTokenVendedor: empresa.mercadopago_access_token,
      valor: resultado.valorFinal,
      descricao: `SchedNext — atendimento em ${empresa.nome}`,
      externalReference: req.params.agendamentoId,
      applicationFee: resultado.valorFinal * (taxaPercentual / 100)
    });

    await supabase
      .from('agendamentos')
      .update({ mercadopago_payment_id: String(cobranca.id), pagamento_status: 'pendente' })
      .eq('id', req.params.agendamentoId)
      .eq('empresa_id', empresa_id);

    res.json({
      payment_id: cobranca.id,
      valor: resultado.valorFinal,
      qr_code: cobranca.point_of_interaction?.transaction_data?.qr_code || null,
      qr_code_base64: cobranca.point_of_interaction?.transaction_data?.qr_code_base64 || null
    });
  } catch (err) {
    if (err.jaConcluido) return res.status(409).json({ error: err.message });
    console.error('Erro ao gerar Pix:', err);
    res.status(500).json({ error: err.message || 'Não foi possível gerar o Pix agora.' });
  }
});

router.get('/admin/mercadopago/pix/:agendamentoId/status', async (req, res) => {
  const { data: agendamento, error } = await supabase
    .from('agendamentos')
    .select('empresa_id, mercadopago_payment_id, pagamento_status')
    .eq('id', req.params.agendamentoId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar agendamento.' });
  if (!agendamento || agendamento.empresa_id !== req.empresaId) {
    return res.status(404).json({ error: 'Agendamento não encontrado.' });
  }
  if (!agendamento.mercadopago_payment_id) return res.json({ pagamento_status: null });

  const { data: empresa } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', req.empresaId).maybeSingle();
  const status = await reconfirmarPagamento({
    agendamentoId: req.params.agendamentoId,
    accessTokenVendedor: empresa?.mercadopago_access_token,
    paymentId: agendamento.mercadopago_payment_id,
    statusAtual: agendamento.pagamento_status
  });
  res.json({ pagamento_status: status });
});

// Mesma checagem de status, só que pro CLIENTE que fez o agendamento (ver Agenda.js) — token
// de cliente comum (verificarTokenCliente), não de admin, e a posse é confirmada por
// usuario_id em vez de empresa_id.
router.get('/pix/:agendamentoId/status', verificarTokenCliente, async (req, res) => {
  const { data: agendamento, error } = await supabase
    .from('agendamentos')
    .select('usuario_id, empresa_id, mercadopago_payment_id, pagamento_status')
    .eq('id', req.params.agendamentoId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar agendamento.' });
  if (!agendamento || String(agendamento.usuario_id) !== req.usuarioId) {
    return res.status(404).json({ error: 'Agendamento não encontrado.' });
  }
  if (!agendamento.mercadopago_payment_id) return res.json({ pagamento_status: null });

  const { data: empresa } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', agendamento.empresa_id).maybeSingle();
  const status = await reconfirmarPagamento({
    agendamentoId: req.params.agendamentoId,
    accessTokenVendedor: empresa?.mercadopago_access_token,
    paymentId: agendamento.mercadopago_payment_id,
    statusAtual: agendamento.pagamento_status
  });
  res.json({ pagamento_status: status });
});

// --- Assinatura do cliente final (mensalidade que o cliente paga pra própria barbearia) ---
//
// Usa o access_token DA EMPRESA (o mesmo do fluxo OAuth do Pix avulso, ver topo do arquivo) —
// o dinheiro cai direto na conta da barbearia, com a fatia da SchedNext via application_fee
// (obterTaxaMarketplace, mesma taxa do Pix). É aditivo: o admin continua podendo atribuir/tirar
// plano na mão (PUT /admin/clientes/:id/plano, routes/assinaturas.js) sem cobrança nenhuma —
// isso aqui só liga a cobrança automática por cima de um plano já atribuído.

router.get('/usuario/:id/assinatura-cobranca', verificarTokenCliente, async (req, res) => {
  if (req.params.id !== req.usuarioId) return res.status(403).json({ error: 'Acesso negado.' });

  const { data: usuario, error } = await supabase
    .from('usuarios')
    .select('empresa_id, plano_id, mercadopago_preapproval_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar assinatura.' });
  if (!usuario?.mercadopago_preapproval_id) return res.json({ status: null });

  const { data: empresa } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', usuario.empresa_id).maybeSingle();
  if (!empresa?.mercadopago_access_token) return res.json({ status: null });

  try {
    const preapproval = await buscarPreapproval({
      accessToken: empresa.mercadopago_access_token,
      preapprovalId: usuario.mercadopago_preapproval_id
    });
    res.json({ status: preapproval.status });
  } catch (err) {
    console.error('Erro ao consultar assinatura do cliente:', err);
    res.json({ status: null });
  }
});

router.post('/usuario/:id/assinatura-cobranca/assinar', verificarTokenCliente, async (req, res) => {
  if (req.params.id !== req.usuarioId) return res.status(403).json({ error: 'Acesso negado.' });

  const { data: usuario, error } = await supabase
    .from('usuarios')
    .select('empresa_id, plano_id, email')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao buscar cliente.' });
  if (!usuario?.plano_id) {
    return res.status(400).json({ error: 'Você ainda não tem um plano atribuído. Fale com a barbearia.' });
  }

  const { data: plano } = await supabase.from('planos_assinatura').select('nome, preco').eq('id', usuario.plano_id).maybeSingle();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado.' });

  const { data: empresa } = await supabase.from('empresas').select('nome, mercadopago_access_token').eq('id', usuario.empresa_id).maybeSingle();
  if (!empresa?.mercadopago_access_token) {
    return res.status(400).json({ error: 'Esta barbearia ainda não conectou o Mercado Pago para cobrança automática.' });
  }

  try {
    const taxaPercentual = await obterTaxaMarketplace(usuario.empresa_id);
    const preapproval = await criarPreapproval({
      accessToken: empresa.mercadopago_access_token,
      reason: `${empresa.nome} — plano ${plano.nome}`,
      valor: plano.preco,
      payerEmail: usuario.email,
      externalReference: req.params.id,
      backUrl: `${process.env.FRONTEND_URL}/assinatura`,
      startDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      applicationFee: plano.preco * (taxaPercentual / 100)
    });

    await supabase.from('usuarios').update({ mercadopago_preapproval_id: preapproval.id }).eq('id', req.params.id);

    res.json({ checkoutUrl: preapproval.init_point });
  } catch (err) {
    console.error('Erro ao criar assinatura do cliente:', err);
    res.status(500).json({ error: 'Não foi possível iniciar a cobrança automática agora.' });
  }
});

router.post('/usuario/:id/assinatura-cobranca/cancelar', verificarTokenCliente, async (req, res) => {
  if (req.params.id !== req.usuarioId) return res.status(403).json({ error: 'Acesso negado.' });

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('empresa_id, mercadopago_preapproval_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!usuario?.mercadopago_preapproval_id) return res.json({ success: true });

  const { data: empresa } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', usuario.empresa_id).maybeSingle();

  try {
    if (empresa?.mercadopago_access_token) {
      await cancelarPreapproval({ accessToken: empresa.mercadopago_access_token, preapprovalId: usuario.mercadopago_preapproval_id });
    }
  } catch (err) {
    console.error('Erro ao cancelar assinatura do cliente no Mercado Pago:', err);
  }

  // Não mexe em `assinante`/`plano_id` — isso continua sob controle do admin (ver
  // routes/assinaturas.js). Só desliga a cobrança automática.
  await supabase.from('usuarios').update({ mercadopago_preapproval_id: null }).eq('id', req.params.id);
  res.json({ success: true });
});

// Rota pública (fora de /admin, então fora do gate de JWT — ver server.js): o Mercado Pago
// redireciona o navegador do admin pra cá depois que ele autoriza a conexão.
router.get('/mercadopago/oauth/callback', async (req, res) => {
  const destino = `${process.env.FRONTEND_URL}/admin/mercadopago`;
  const { code, state, error: erroMp } = req.query;

  if (erroMp || !code || !state) {
    return res.redirect(`${destino}?erro=${encodeURIComponent('Autorização cancelada ou incompleta.')}`);
  }

  let empresaId;
  try {
    ({ empresaId } = jwt.verify(state, process.env.JWT_SECRET));
  } catch (e) {
    return res.redirect(`${destino}?erro=${encodeURIComponent('Sessão de conexão expirada, tente novamente.')}`);
  }

  try {
    const token = await trocarCodigoPorToken({ code, redirectUri: redirectUriCallback(req) });
    const expiraEm = new Date(Date.now() + Number(token.expires_in) * 1000).toISOString();

    await supabase
      .from('empresas')
      .update({
        mercadopago_access_token: token.access_token,
        mercadopago_refresh_token: token.refresh_token,
        mercadopago_user_id: String(token.user_id),
        mercadopago_token_expira_em: expiraEm
      })
      .eq('id', empresaId);

    res.redirect(`${destino}?conectado=true`);
  } catch (err) {
    console.error('Erro ao trocar código do Mercado Pago por token:', err);
    res.redirect(`${destino}?erro=${encodeURIComponent('Não foi possível concluir a conexão com o Mercado Pago.')}`);
  }
});

// Webhook do Mercado Pago (notificação de pagamento). Assinatura validada via header
// x-signature, formato documentado pelo Mercado Pago: "ts=<timestamp>,v1=<hash>", onde hash é
// um HMAC-SHA256 de "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" usando a Webhook Secret
// Key configurada no painel de desenvolvedor (Aplicação → Webhooks). Sem
// MERCADOPAGO_WEBHOOK_SECRET configurado, recusa toda chamada (fail-closed) — mesmo padrão já
// usado no webhook do Asaas (ver routes/pagamentos.js).
// Reconfirma e aplica o status de uma assinatura (preapproval) de verdade, direto na API —
// nunca confia só no payload do webhook. Busca primeiro como assinatura DA PLATAFORMA
// (empresas.gateway_subscription_id, cobrada com o access_token da própria SchedNext); se não
// achar, busca como assinatura de CLIENTE FINAL (usuarios.mercadopago_preapproval_id, cobrada
// com o access_token da empresa dona do cliente).
async function processarNotificacaoAssinatura(preapprovalId) {
  const { data: empresaPlataforma } = await supabase
    .from('empresas')
    .select('id, plano_plataforma_pendente_id')
    .eq('gateway_subscription_id', preapprovalId)
    .maybeSingle();

  if (empresaPlataforma) {
    const preapproval = await buscarPreapproval({
      accessToken: process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN,
      preapprovalId
    });

    const ativa = preapproval.status === 'authorized';
    const atualizacao = { status_assinatura: ativa ? 'ativa' : 'inadimplente' };
    // Mesmo gatilho que o webhook do Asaas tinha: o plano escolhido em "trocar de plano" só
    // passa a valer de verdade quando o Mercado Pago confirma a autorização.
    if (ativa && empresaPlataforma.plano_plataforma_pendente_id) {
      atualizacao.plano_plataforma_id = empresaPlataforma.plano_plataforma_pendente_id;
      atualizacao.plano_plataforma_pendente_id = null;
    }
    await supabase.from('empresas').update(atualizacao).eq('id', empresaPlataforma.id);
    return;
  }

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id, empresa_id')
    .eq('mercadopago_preapproval_id', preapprovalId)
    .maybeSingle();
  if (!usuario) return;

  const { data: empresaCliente } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', usuario.empresa_id).maybeSingle();
  if (!empresaCliente?.mercadopago_access_token) return;

  const preapproval = await buscarPreapproval({ accessToken: empresaCliente.mercadopago_access_token, preapprovalId });
  await supabase.from('usuarios').update({ assinante: preapproval.status === 'authorized' }).eq('id', usuario.id);
}

router.post('/webhooks/mercadopago', async (req, res) => {
  const segredo = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!segredo) {
    console.error('MERCADOPAGO_WEBHOOK_SECRET não configurado, recusando webhook de pagamento.');
    return res.status(503).json({ error: 'Webhook de pagamento não configurado.' });
  }

  const assinatura = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();

  const partes = Object.fromEntries(
    assinatura.split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2)
  );
  const { ts, v1 } = partes;

  if (!ts || !v1 || !dataId) {
    return res.status(400).json({ error: 'Payload de webhook inválido.' });
  }

  const manifesto = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const hashEsperado = crypto.createHmac('sha256', segredo).update(manifesto).digest('hex');

  const bufEsperado = Buffer.from(hashEsperado);
  const bufRecebido = Buffer.from(v1);
  const valido = bufEsperado.length === bufRecebido.length && crypto.timingSafeEqual(bufEsperado, bufRecebido);

  if (!valido) return res.status(401).json({ error: 'Assinatura inválida.' });

  const tipo = req.body?.type;

  // Mudança de status da assinatura (autorizada/cancelada/pausada) — cobre tanto a assinatura
  // da própria plataforma quanto a do cliente final (ver processarNotificacaoAssinatura acima).
  if (tipo === 'subscription_preapproval') {
    try {
      await processarNotificacaoAssinatura(dataId);
    } catch (err) {
      console.error('Erro ao processar webhook de assinatura:', err);
    }
    return res.json({ recebido: true });
  }

  // Cobrança individual de um ciclo da assinatura (aprovada/rejeitada). dataId aqui é o id
  // dessa cobrança pontual, não da assinatura — precisa resolver o preapproval_id primeiro.
  // Só tenta com o token da PLATAFORMA por enquanto (cobre a assinatura da própria SchedNext,
  // que é quem existe de verdade hoje) — resolver isso pra assinatura de cliente final exigiria
  // varrer o token de cada empresa conectada, o que não escala; a transição de status do
  // preapproval em si (acima) já cobre a maior parte dos casos práticos pro cliente final.
  if (tipo === 'subscription_authorized_payment') {
    if (process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN) {
      try {
        const pagamentoAutorizado = await buscarPagamentoAutorizado({
          accessToken: process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN,
          id: dataId
        });
        if (pagamentoAutorizado?.preapproval_id) {
          await processarNotificacaoAssinatura(pagamentoAutorizado.preapproval_id);
        }
      } catch (err) {
        console.error('Erro ao processar webhook de cobrança de assinatura:', err);
      }
    }
    return res.json({ recebido: true });
  }

  if (tipo && tipo !== 'payment') {
    return res.json({ recebido: true, ignorado: true });
  }

  const { data: agendamento } = await supabase
    .from('agendamentos')
    .select('id, empresa_id')
    .eq('mercadopago_payment_id', dataId)
    .maybeSingle();

  if (!agendamento) return res.json({ recebido: true, agendamentoNaoEncontrado: true });

  const { data: empresa } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', agendamento.empresa_id).maybeSingle();

  // Nunca confia no payload do webhook por si só — reconfirmarPagamento rebusca o pagamento de
  // verdade antes de marcar como pago (mesmo princípio do webhook do Asaas).
  await reconfirmarPagamento({
    agendamentoId: agendamento.id,
    accessTokenVendedor: empresa?.mercadopago_access_token,
    paymentId: dataId,
    statusAtual: null
  });

  res.json({ recebido: true });
});

module.exports = router;
