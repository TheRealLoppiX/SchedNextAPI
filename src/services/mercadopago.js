const crypto = require('crypto');

// Cliente HTTP fino pro Mercado Pago (gateway de cobrança de agendamento/PDV, ver
// src/routes/mercadopago.js pra onde isso é usado). Modelo "vendedor conectado": cada empresa
// autoriza a SchedNext via OAuth (MERCADOPAGO_CLIENT_ID/SECRET identificam a aplicação da
// própria SchedNext, cadastrada no painel de desenvolvedor do Mercado Pago) e a cobrança de
// cada Pix é feita com o access_token DA EMPRESA, nunca o nosso — o dinheiro cai direto na
// conta dela, com a nossa fatia (application_fee) descontada automaticamente pelo Mercado Pago.

const BASE_URL = 'https://api.mercadopago.com';

async function request(path, { method = 'GET', body, accessToken, idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  const resposta = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const erro = new Error(dados?.message || dados?.error || 'Erro na API do Mercado Pago.');
    erro.mercadoPagoErrors = dados;
    erro.status = resposta.status;
    throw erro;
  }

  return dados;
}

// Troca o `code` recebido no callback do OAuth pelo access_token/refresh_token da empresa que
// acabou de autorizar. redirectUri precisa ser IDÊNTICA à usada pra montar a URL de autorização
// (exigência do próprio Mercado Pago), ver montarUrlAutorizacao abaixo.
async function trocarCodigoPorToken({ code, redirectUri }) {
  return request('/oauth/token', {
    method: 'POST',
    body: {
      client_id: process.env.MERCADOPAGO_CLIENT_ID,
      client_secret: process.env.MERCADOPAGO_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    }
  });
}

async function renovarToken(refreshToken) {
  return request('/oauth/token', {
    method: 'POST',
    body: {
      client_id: process.env.MERCADOPAGO_CLIENT_ID,
      client_secret: process.env.MERCADOPAGO_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }
  });
}

function montarUrlAutorizacao({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.MERCADOPAGO_CLIENT_ID,
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: redirectUri,
    state
  });
  return `https://auth.mercadopago.com.br/authorization?${params.toString()}`;
}

// Cria a cobrança Pix na conta DA EMPRESA (accessTokenVendedor). applicationFee é um valor em
// reais (não percentual — o Mercado Pago espera o valor já calculado), omitido quando 0 pra não
// mandar uma fatia de R$0 explícita. X-Idempotency-Key evita cobrar duas vezes se a requisição
// for reenviada por retry de rede.
async function criarPagamentoPix({ accessTokenVendedor, valor, descricao, externalReference, payerEmail, applicationFee }) {
  return request('/v1/payments', {
    method: 'POST',
    accessToken: accessTokenVendedor,
    idempotencyKey: crypto.randomUUID(),
    body: {
      transaction_amount: Number(valor),
      description: descricao,
      payment_method_id: 'pix',
      external_reference: String(externalReference),
      payer: { email: payerEmail || 'cliente@schednext.com.br' },
      ...(applicationFee > 0 ? { application_fee: Number(applicationFee.toFixed(2)) } : {})
    }
  });
}

// Nunca confiar no payload do webhook por si só — sempre rebuscar o pagamento de verdade com o
// token da empresa dona dele antes de considerar um Pix como pago (mesmo princípio já usado no
// webhook do Asaas, ver routes/pagamentos.js).
async function buscarPagamento({ accessTokenVendedor, paymentId }) {
  return request(`/v1/payments/${paymentId}`, { accessToken: accessTokenVendedor });
}

module.exports = {
  montarUrlAutorizacao,
  trocarCodigoPorToken,
  renovarToken,
  criarPagamentoPix,
  buscarPagamento
};
