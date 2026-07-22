// Cliente HTTP fino pro Asaas (gateway de cobrança, ver src/services/pagamento.js pra onde
// isso é usado). ASAAS_ENV decide sandbox vs produção; ASAAS_API_KEY vai no header `access_token`
// exigido pela API deles em todo request.

function baseUrl() {
  return process.env.ASAAS_ENV === 'sandbox'
    ? 'https://sandbox.asaas.com/api/v3'
    : 'https://api.asaas.com/v3';
}

async function request(method, path, body) {
  const resposta = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      access_token: process.env.ASAAS_API_KEY,
      'Content-Type': 'application/json',
      // Exigido pela API do Asaas — sem isso todo request cai com 400 "user_agent_not_informed"
      // (o fetch nativo do Node não manda um User-Agent por padrão, diferente de curl/browsers).
      'User-Agent': 'SchedNext',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const erro = new Error(dados?.errors?.[0]?.description || 'Erro na API do Asaas.');
    erro.asaasErrors = dados?.errors;
    erro.status = resposta.status;
    throw erro;
  }

  return dados;
}

async function criarCliente({ nome, email, cpfCnpj, externalReference }) {
  return request('POST', '/customers', { name: nome, email, cpfCnpj, externalReference });
}

async function criarAssinatura({ customerId, valor, nextDueDate, descricao, externalReference }) {
  return request('POST', '/subscriptions', {
    customer: customerId,
    billingType: 'UNDEFINED', // deixa o pagador escolher Pix/boleto/cartão na página hospedada do Asaas
    cycle: 'MONTHLY',
    value: valor,
    nextDueDate,
    description: descricao,
    externalReference,
  });
}

async function cancelarAssinatura(subscriptionId) {
  // DELETE em assinatura já cancelada/inexistente responde 404 — tratado como sucesso pelo
  // chamador (o objetivo, "não cobrar de novo", já está satisfeito).
  try {
    return await request('DELETE', `/subscriptions/${subscriptionId}`);
  } catch (e) {
    if (e.status === 404) return { deleted: true };
    throw e;
  }
}

async function buscarAssinatura(subscriptionId) {
  return request('GET', `/subscriptions/${subscriptionId}`);
}

async function buscarPrimeiroPagamento(subscriptionId) {
  const resultado = await request('GET', `/payments?subscription=${subscriptionId}&limit=1`);
  return resultado?.data?.[0] || null;
}

module.exports = {
  criarCliente,
  criarAssinatura,
  cancelarAssinatura,
  buscarAssinatura,
  buscarPrimeiroPagamento,
};
