const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('../services/whatsapp/provider');
const validate = require('../middleware/validate');
const verificarTokenCliente = require('../middleware/clienteAuth');
const { mercadoPagoPixSchema, assinarAssinaturaSchema } = require('../schemas');
const { obterTaxaMarketplace, permiteWhatsappBot } = require('../utils/limitesPlano');
const { calcularValorFinalCheckout } = require('../services/pagamentoAgendamento');
const {
  gerarCobrancaPix,
  enviarNotificacaoCobrancaPix,
  confirmarCicloCartao,
  marcarInadimplente,
  marcarEmDia
} = require('../services/cobrancaAssinatura');
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
  if (statusAtual === 'pago' || statusAtual === 'falhou' || !accessTokenVendedor) return statusAtual;

  try {
    const pagamento = await buscarPagamento({ accessTokenVendedor, paymentId });
    if (pagamento.status === 'approved') {
      await supabase.from('agendamentos').update({ pagamento_status: 'pago' }).eq('id', agendamentoId);
      notificarPagamentoConfirmado(agendamentoId).catch((err) => console.error('Erro ao notificar pagamento confirmado:', err));
      return 'pago';
    }
    // 'rejected'/'cancelled' são terminais pro Pix (não fica tentando de novo sozinho, o
    // pagador precisa gerar um Pix novo) — sem escrever esse estado, o front ficava com
    // polling infinito mostrando "aguardando confirmação" mesmo com o pagamento já morto.
    if (pagamento.status === 'rejected' || pagamento.status === 'cancelled') {
      await supabase.from('agendamentos').update({ pagamento_status: 'falhou' }).eq('id', agendamentoId);
      return 'falhou';
    }
  } catch (err) {
    console.error('Erro ao reconfirmar pagamento Pix:', err);
  }
  return statusAtual;
}

// Recibo de pagamento pro cliente final quando o Pix (agendamento ou PDV) é confirmado. Chamada
// só a partir da transição de estado acima (nunca de novo pro mesmo agendamento, já que
// reconfirmarPagamento retorna cedo assim que statusAtual já é 'pago'), então dispara uma vez só.
async function notificarPagamentoConfirmado(agendamentoId) {
  const { data: agendamento } = await supabase
    .from('agendamentos')
    .select('data_hora, valor_total, empresa_id, usuario_id, usuarios(email, nome_completo, telefone), empresas(nome, whatsapp_phone_number_id)')
    .eq('id', agendamentoId)
    .maybeSingle();

  if (!agendamento?.usuarios) return;

  const dataFormatada = new Date(agendamento.data_hora).toLocaleString('pt-BR');
  const nomeEmpresa = agendamento.empresas?.nome || 'SchedNext';

  if (agendamento.usuarios.email) {
    transporter.sendMail({
      to: agendamento.usuarios.email,
      subject: `Pagamento confirmado - ${nomeEmpresa}`,
      html: emailHtml({
        titulo: `Olá, ${agendamento.usuarios.nome_completo}!`,
        mensagemHtml: `
          <p style="margin: 0 0 4px;">Recebemos seu pagamento via Pix referente ao atendimento na <strong>${nomeEmpresa}</strong>:</p>
          <p style="margin: 12px 0; font-size: 15px;"><strong>Data:</strong> ${dataFormatada}<br><strong>Valor pago:</strong> R$ ${agendamento.valor_total}</p>
        `
      })
    }).catch((err) => console.error('Erro ao enviar e-mail de confirmação de pagamento:', err));
  }

  if (agendamento.usuarios.telefone && (await permiteWhatsappBot(agendamento.empresa_id))) {
    enviarMensagem(
      agendamento.empresas?.whatsapp_phone_number_id,
      `55${agendamento.usuarios.telefone.replace(/\D/g, '')}`,
      `✅ Pagamento confirmado! ${nomeEmpresa}, ${dataFormatada}. Valor: R$ ${agendamento.valor_total}.`
    ).catch((err) => console.error('Erro ao enviar WhatsApp de confirmação de pagamento:', err));
  }
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
  const { produtos_vendidos, servicos_adicionais, valor } = req.body;
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
      unidadeId: req.unidadeId,
      produtosVendidos: produtos_vendidos,
      servicosAdicionais: servicos_adicionais
    });
    if (!resultado) return res.status(404).json({ error: 'Agendamento não encontrado.' });
    if (!(resultado.valorFinal > 0)) {
      return res.status(400).json({ error: 'Não há valor a cobrar para este atendimento.' });
    }

    // `valor` só vem preenchido em pagamento dividido — cobra só a perna do Pix, o resto fica
    // com outra(s) forma(s) registrada(s) no fechamento de caixa (ver finalizar-servico-checkout).
    // Sem `valor`, cobra o total do atendimento (fluxo de sempre, Pix único).
    const valorCobranca = valor != null ? Number(valor) : resultado.valorFinal;
    if (valorCobranca > resultado.valorFinal + 0.01) {
      return res.status(400).json({ error: 'O valor do Pix não pode ser maior que o total do atendimento.' });
    }

    // Duplo clique em "gerar Pix" (ou um retry de rede) criava uma segunda cobrança pro mesmo
    // atendimento, com só a mais recente ficando salva em `mercadopago_payment_id` — a anterior
    // ficava órfã, mas ainda válida pro pagador pagar (dinheiro indo pro mesmo lugar, só
    // confuso). Se já existe uma cobrança pendente registrada, reconfirma o status dela antes de
    // decidir: se ainda está pendente de verdade na Mercado Pago E é do MESMO valor pedido agora
    // (senão o staff mudou a divisão entre um clique e outro), devolve o mesmo QR Code em vez de
    // gerar um novo.
    const { agendamento: agAtual } = resultado;
    if (agAtual.pagamento_status === 'pendente' && agAtual.mercadopago_payment_id) {
      try {
        const pagamentoExistente = await buscarPagamento({
          accessTokenVendedor: empresa.mercadopago_access_token,
          paymentId: agAtual.mercadopago_payment_id
        });
        const mesmoValor = Math.abs(Number(pagamentoExistente.transaction_amount || 0) - valorCobranca) < 0.01;
        if (mesmoValor && (pagamentoExistente.status === 'pending' || pagamentoExistente.status === 'in_process')) {
          return res.json({
            payment_id: pagamentoExistente.id,
            valor: valorCobranca,
            qr_code: pagamentoExistente.point_of_interaction?.transaction_data?.qr_code || null,
            qr_code_base64: pagamentoExistente.point_of_interaction?.transaction_data?.qr_code_base64 || null
          });
        }
      } catch (err) {
        console.error('Erro ao reconfirmar Pix pendente existente, gerando um novo:', err);
      }
    }

    const taxaPercentual = await obterTaxaMarketplace(empresa_id);
    const cobranca = await criarPagamentoPix({
      accessTokenVendedor: empresa.mercadopago_access_token,
      valor: valorCobranca,
      descricao: `SchedNext — atendimento em ${empresa.nome}`,
      externalReference: req.params.agendamentoId,
      applicationFee: valorCobranca * (taxaPercentual / 100)
    });

    await supabase
      .from('agendamentos')
      .update({ mercadopago_payment_id: String(cobranca.id), pagamento_status: 'pendente' })
      .eq('id', req.params.agendamentoId)
      .eq('empresa_id', empresa_id);

    res.json({
      payment_id: cobranca.id,
      valor: valorCobranca,
      qr_code: cobranca.point_of_interaction?.transaction_data?.qr_code || null,
      qr_code_base64: cobranca.point_of_interaction?.transaction_data?.qr_code_base64 || null
    });
  } catch (err) {
    if (err.jaConcluido) return res.status(409).json({ error: err.message });
    console.error('Erro ao gerar Pix:', err);
    // Não repassa err.message pro cliente final — vinha cru da API do Mercado Pago
    // (services/mercadopago.js:request), podia expor detalhe interno/nomenclatura da API.
    res.status(500).json({ error: 'Não foi possível gerar o Pix agora. Tente novamente em instantes.' });
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

// forma_pagamento (opcional, default 'cartao'): 'cartao' mantém o fluxo de preapproval de
// sempre; 'pix' gera uma cobrança Pix avulsa pro ciclo atual (Mercado Pago não tem Pix
// recorrente — cada ciclo seguinte é gerado pelo cron, ver cron/cobrancaAssinaturas.js).
router.post('/usuario/:id/assinatura-cobranca/assinar', verificarTokenCliente, validate(assinarAssinaturaSchema), async (req, res) => {
  if (req.params.id !== req.usuarioId) return res.status(403).json({ error: 'Acesso negado.' });
  const formaPagamento = req.body.forma_pagamento || 'cartao';

  const { data: usuario, error } = await supabase
    .from('usuarios')
    .select('id, empresa_id, plano_id, nome_completo, email, telefone, assinante_desde')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao buscar cliente.' });
  if (!usuario?.plano_id) {
    return res.status(400).json({ error: 'Você ainda não tem um plano atribuído. Fale com a barbearia.' });
  }

  const { data: plano } = await supabase.from('planos_assinatura').select('id, nome, preco').eq('id', usuario.plano_id).maybeSingle();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado.' });

  const { data: empresa } = await supabase.from('empresas').select('id, nome, mercadopago_access_token, whatsapp_phone_number_id').eq('id', usuario.empresa_id).maybeSingle();
  if (!empresa?.mercadopago_access_token) {
    return res.status(400).json({ error: 'Esta barbearia ainda não conectou o Mercado Pago para cobrança automática.' });
  }

  if (formaPagamento === 'pix') {
    try {
      const { qr_code, qr_code_base64 } = await gerarCobrancaPix({ usuario, empresa, plano });
      await enviarNotificacaoCobrancaPix({ usuario, empresa, plano, qrCode: qr_code, qrCodeBase64: qr_code_base64 });
      await supabase.from('usuarios').update({ assinatura_forma_pagamento: 'pix' }).eq('id', req.params.id);
      res.json({ qr_code, qr_code_base64 });
    } catch (err) {
      console.error('Erro ao gerar Pix da assinatura do cliente:', err);
      res.status(500).json({ error: 'Não foi possível gerar o Pix da assinatura agora. Tente novamente em instantes.' });
    }
    return;
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

    await supabase.from('usuarios').update({ mercadopago_preapproval_id: preapproval.id, assinatura_forma_pagamento: 'cartao' }).eq('id', req.params.id);

    res.json({ checkoutUrl: preapproval.init_point });
  } catch (err) {
    console.error('Erro ao criar assinatura do cliente:', err);
    res.status(500).json({ error: 'Não foi possível iniciar a cobrança automática agora.' });
  }
});

// Polling do Pix da assinatura pelo cliente — mesmo padrão de GET /pix/:agendamentoId/status,
// só que a "posse" é confirmada batendo o usuario_id da cobrança com o token do cliente.
router.get('/usuario/:id/assinatura-cobranca/pix/status', verificarTokenCliente, async (req, res) => {
  if (req.params.id !== req.usuarioId) return res.status(403).json({ error: 'Acesso negado.' });

  const { data: cobranca, error } = await supabase
    .from('assinatura_cobrancas')
    .select('id, empresa_id, mercadopago_payment_id, status')
    .eq('usuario_id', req.params.id)
    .eq('forma_pagamento', 'pix')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar cobrança.' });
  if (!cobranca?.mercadopago_payment_id) return res.json({ status: null });
  if (cobranca.status !== 'pendente') return res.json({ status: cobranca.status });

  const { data: empresa } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', cobranca.empresa_id).maybeSingle();
  if (!empresa?.mercadopago_access_token) return res.json({ status: cobranca.status });

  try {
    const pagamento = await buscarPagamento({ accessTokenVendedor: empresa.mercadopago_access_token, paymentId: cobranca.mercadopago_payment_id });
    if (pagamento.status === 'approved') {
      await supabase.from('assinatura_cobrancas').update({ status: 'pago', pago_em: new Date().toISOString() }).eq('id', cobranca.id);
      await marcarEmDia(req.params.id);
      return res.json({ status: 'pago' });
    }
    if (pagamento.status === 'rejected' || pagamento.status === 'cancelled') {
      await supabase.from('assinatura_cobrancas').update({ status: 'falhou' }).eq('id', cobranca.id);
      return res.json({ status: 'falhou' });
    }
  } catch (err) {
    console.error('Erro ao reconfirmar Pix da assinatura:', err);
  }
  res.json({ status: 'pendente' });
});

router.post('/usuario/:id/assinatura-cobranca/cancelar', verificarTokenCliente, async (req, res) => {
  if (req.params.id !== req.usuarioId) return res.status(403).json({ error: 'Acesso negado.' });

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('empresa_id, mercadopago_preapproval_id, assinatura_forma_pagamento')
    .eq('id', req.params.id)
    .maybeSingle();

  if (usuario?.mercadopago_preapproval_id) {
    const { data: empresa } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', usuario.empresa_id).maybeSingle();
    try {
      if (empresa?.mercadopago_access_token) {
        await cancelarPreapproval({ accessToken: empresa.mercadopago_access_token, preapprovalId: usuario.mercadopago_preapproval_id });
      }
    } catch (err) {
      console.error('Erro ao cancelar assinatura do cliente no Mercado Pago:', err);
    }
  }

  // Não mexe em `assinante`/`plano_id` — isso continua sob controle do admin (ver
  // routes/assinaturas.js). Só desliga a cobrança automática (cartão ou Pix).
  await supabase.from('usuarios').update({ mercadopago_preapproval_id: null, assinatura_forma_pagamento: null }).eq('id', req.params.id);
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
    .select('id, nome, email, plano_plataforma_pendente_id, status_assinatura')
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
    // Sem isso, `proxima_cobranca_em` nunca era escrito em lugar nenhum do sistema (só zerado
    // no cancelamento) — o que quebrava silenciosamente TRÊS consumidores dessa coluna:
    // POST /admin/assinatura-plataforma/cancelar-cobranca (sempre recusava com "sem cobrança
    // ativa"), o cron de downgrade pós-cancelamento (routes/../cron/assinaturas.js, nunca
    // encontrava nenhuma linha vencida) e reativarAssinaturaNoGateway (services/pagamento.js,
    // sempre caía no fallback de "amanhã" em vez da data prometida ao cliente). O Mercado Pago
    // cobra mensalmente (mesma cadência de `criarPreapproval`, frequency:1/months), então cada
    // ativação/renovação empurra a data prevista da próxima cobrança em 1 mês a partir de agora.
    if (ativa) {
      const proxima = new Date();
      proxima.setMonth(proxima.getMonth() + 1);
      atualizacao.proxima_cobranca_em = proxima.toISOString();
    }
    await supabase.from('empresas').update(atualizacao).eq('id', empresaPlataforma.id);

    // Avisa o dono da empresa quando a cobrança da própria plataforma falha (cartão recusado,
    // etc.) — antes disso acontecia 100% em silêncio, o admin só descobria ao perder acesso a
    // recursos do plano. Só dispara na transição pra inadimplente (evita reenviar o mesmo aviso
    // a cada notificação repetida do Mercado Pago pro mesmo status).
    if (!ativa && empresaPlataforma.status_assinatura !== 'inadimplente' && empresaPlataforma.email) {
      transporter.sendMail({
        to: empresaPlataforma.email,
        subject: 'Não conseguimos confirmar o pagamento da sua assinatura - SchedNext',
        html: emailHtml({
          titulo: `Olá, ${empresaPlataforma.nome}!`,
          mensagemHtml: `
            <p style="margin: 0 0 4px;">Não conseguimos confirmar o pagamento da sua assinatura na SchedNext.</p>
            <p style="margin: 12px 0;">Verifique os dados de cobrança no painel administrativo para evitar interrupção dos recursos do seu plano.</p>
          `
        })
      }).catch((err) => console.error('Erro ao enviar e-mail de assinatura inadimplente:', err));
    }
    return;
  }

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id, empresa_id, nome_completo, email, telefone, assinante_desde, status_assinatura')
    .eq('mercadopago_preapproval_id', preapprovalId)
    .maybeSingle();
  if (!usuario) return;

  const { data: empresaCliente } = await supabase.from('empresas').select('id, nome, mercadopago_access_token, whatsapp_phone_number_id').eq('id', usuario.empresa_id).maybeSingle();
  if (!empresaCliente?.mercadopago_access_token) return;

  const preapproval = await buscarPreapproval({ accessToken: empresaCliente.mercadopago_access_token, preapprovalId });

  // Diferente da assinatura da plataforma, `assinante`/`plano_id` NÃO são tocados aqui — o
  // vínculo do cliente com o plano continua sob controle do admin (routes/assinaturas.js). Só o
  // status de inadimplência (que suspende preço/cota, ver utils/limitesAssinatura.js) reage ao
  // preapproval.
  if (preapproval.status === 'authorized') {
    await marcarEmDia(usuario.id);
    await confirmarCicloCartao(usuario);
  } else {
    await marcarInadimplente(usuario, empresaCliente);
    // 'cancelled' é terminal pro preapproval (não dá pra reabrir, só criar um novo) — desliga a
    // cobrança automática pra não deixar o cliente crendo que ainda está configurada.
    if (preapproval.status === 'cancelled') {
      await supabase.from('usuarios').update({ mercadopago_preapproval_id: null, assinatura_forma_pagamento: null }).eq('id', usuario.id);
    }
  }
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
        // 'processed' é o único status de authorized_payment que significa "essa cobrança
        // do ciclo foi debitada de verdade". O preapproval associado continua 'authorized'
        // mesmo quando essa cobrança específica falha e o Mercado Pago fica retentando
        // (ver status 'scheduled'/'pending'/'recycled'/'cancelled'/'rejected') — chamar
        // processarNotificacaoAssinatura só com base no preapproval.status confirmava
        // assinaturas cuja cobrança do mês nunca foi paga.
        if (pagamentoAutorizado?.preapproval_id && pagamentoAutorizado.status === 'processed') {
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

  if (!agendamento) {
    // Não é Pix de atendimento — tenta como Pix de mensalidade de assinatura de cliente final
    // (ver services/cobrancaAssinatura.js). Mesmo princípio de nunca confiar só no payload: só
    // marca pago depois de reconfirmar direto na API.
    const { data: cobranca } = await supabase
      .from('assinatura_cobrancas')
      .select('id, usuario_id, empresa_id, status')
      .eq('mercadopago_payment_id', dataId)
      .maybeSingle();

    if (!cobranca) return res.json({ recebido: true, agendamentoNaoEncontrado: true });
    if (cobranca.status !== 'pendente') return res.json({ recebido: true });

    const { data: empresaCobranca } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', cobranca.empresa_id).maybeSingle();
    if (empresaCobranca?.mercadopago_access_token) {
      try {
        const pagamento = await buscarPagamento({ accessTokenVendedor: empresaCobranca.mercadopago_access_token, paymentId: dataId });
        if (pagamento.status === 'approved') {
          await supabase.from('assinatura_cobrancas').update({ status: 'pago', pago_em: new Date().toISOString() }).eq('id', cobranca.id);
          await marcarEmDia(cobranca.usuario_id);
        } else if (pagamento.status === 'rejected' || pagamento.status === 'cancelled') {
          await supabase.from('assinatura_cobrancas').update({ status: 'falhou' }).eq('id', cobranca.id);
        }
      } catch (err) {
        console.error('Erro ao reconfirmar Pix de assinatura via webhook:', err);
      }
    }
    return res.json({ recebido: true });
  }

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
