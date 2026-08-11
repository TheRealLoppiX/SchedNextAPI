// Adapter de cobrança da ASSINATURA DA PLATAFORMA (empresa paga a SchedNext pelo plano —
// diferente do Pix avulso de agendamento/PDV, que usa o access_token de cada empresa via OAuth,
// ver services/mercadopago.js). Aqui é a própria SchedNext vendendo, então usa o access_token
// PRÓPRIO da SchedNext (MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN), sem intermediário nenhum. Este
// arquivo é o único lugar que conhece esse detalhe; routes/pagamentos.js só chama estas funções
// (mesma interface pública de quando o gateway era o Asaas — só o que acontece por dentro mudou).
//
// Enquanto MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN não estiver configurado, empresas em plano pago
// entram como `status_assinatura = 'trial'` (ver routes/empresasPublico.js) e não são bloqueadas.

const mercadopago = require('./mercadopago');

function estaConfigurado() {
  return Boolean(process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN);
}

function amanha() {
  const data = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return data.toISOString().slice(0, 10);
}

// Cria um preapproval (assinatura recorrente por cartão) e devolve a URL de checkout hospedada
// pelo Mercado Pago (pagador autoriza o cartão lá, nós nunca tocamos em dado de cartão).
// gatewayCustomerIdExistente/cpfCnpj não são usados pelo Mercado Pago (ele não tem conceito de
// "cliente" separado do preapproval, e não exige CPF/CNPJ pra criar a cobrança) — mantidos nos
// parâmetros só pra não precisar mexer em routes/pagamentos.js.
async function criarCheckout({ empresaId, planoNome, precoMensal, email }) {
  if (!estaConfigurado()) {
    return {
      configurado: false,
      message: 'Cobrança automática ainda não está disponível. Seu plano fica em modo de teste até a cobrança ser ativada, fale com o suporte.'
    };
  }

  const preapproval = await mercadopago.criarPreapproval({
    accessToken: process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN,
    reason: `SchedNext — plano ${planoNome}`,
    valor: precoMensal,
    payerEmail: email,
    externalReference: empresaId,
    backUrl: `${process.env.FRONTEND_URL}/admin/conta`,
    startDate: amanha()
  });

  return {
    configurado: true,
    checkoutUrl: preapproval.init_point,
    gatewayCustomerId: null,
    gatewaySubscriptionId: preapproval.id,
    message: 'Assinatura criada! Finalize a autorização na página que abriu para ativar o plano.'
  };
}

// Usado tanto por "cancelar cobrança" (mantém acesso até proxima_cobranca_em, só impede a
// PRÓXIMA cobrança) quanto por "cancelar plano agora" (downgrade imediato) — nos dois casos o
// efeito no gateway é o mesmo: parar de cobrar. A diferença de UX fica só no lado local
// (routes/pagamentos.js decide se derruba o plano na hora ou deixa rodar até a data).
async function cancelarAssinaturaNoGateway(gatewaySubscriptionId) {
  if (!estaConfigurado() || !gatewaySubscriptionId) return;
  await mercadopago.cancelarPreapproval({
    accessToken: process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN,
    preapprovalId: gatewaySubscriptionId
  });
}

// Preapproval cancelado no Mercado Pago é terminal (não dá pra "reabrir") — reativar cobrança
// aqui sempre cria um preapproval NOVO, com a mesma data de próxima cobrança já prometida ao
// cliente. Precisa do e-mail da empresa (o Mercado Pago exige payer_email em todo preapproval
// novo — diferente do Asaas, que já tinha isso amarrado no gatewayCustomerId).
async function reativarAssinaturaNoGateway({ empresaId, email, planoNome, precoMensal, proximaCobrancaEm }) {
  if (!estaConfigurado()) return null;

  const startDate = proximaCobrancaEm
    ? new Date(proximaCobrancaEm).toISOString().slice(0, 10)
    : amanha();

  const preapproval = await mercadopago.criarPreapproval({
    accessToken: process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN,
    reason: `SchedNext — plano ${planoNome}`,
    valor: precoMensal,
    payerEmail: email,
    externalReference: empresaId,
    backUrl: `${process.env.FRONTEND_URL}/admin/conta`,
    startDate
  });

  return preapproval.id;
}

module.exports = { estaConfigurado, criarCheckout, cancelarAssinaturaNoGateway, reativarAssinaturaNoGateway };
