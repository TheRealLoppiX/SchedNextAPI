// Adapter de cobrança. Gateway escolhido: Asaas (aceita CPF, sem mensalidade, cobra só por
// transação — ver src/services/asaas.js pro cliente HTTP). Este arquivo é o único lugar que
// conhece o formato de resposta do Asaas; routes/pagamentos.js só chama estas funções.
//
// Enquanto ASAAS_API_KEY não estiver configurado, empresas em plano pago entram como
// `status_assinatura = 'trial'` (ver routes/empresasPublico.js) e não são bloqueadas.

const asaas = require('./asaas');

function estaConfigurado() {
  return Boolean(process.env.ASAAS_API_KEY);
}

function amanha() {
  const data = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return data.toISOString().slice(0, 10);
}

// Cria (ou reaproveita) o cliente no Asaas e abre uma assinatura mensal, devolvendo a URL de
// checkout hospedada pelo Asaas (pagador escolhe Pix/boleto/cartão lá, nós nunca tocamos em
// dado de cartão). `gatewayCustomerIdExistente` evita recriar o cliente a cada troca de plano.
async function criarCheckout({ empresaId, planoNome, precoMensal, nomeEmpresa, email, cpfCnpj, gatewayCustomerIdExistente }) {
  if (!estaConfigurado()) {
    return {
      configurado: false,
      message: 'Cobrança automática ainda não está disponível. Seu plano fica em modo de teste até a cobrança ser ativada, fale com o suporte.'
    };
  }

  let customerId = gatewayCustomerIdExistente;
  if (!customerId) {
    const cliente = await asaas.criarCliente({
      nome: nomeEmpresa,
      email,
      cpfCnpj: String(cpfCnpj).replace(/\D/g, ''),
      externalReference: String(empresaId)
    });
    customerId = cliente.id;
  }

  const assinatura = await asaas.criarAssinatura({
    customerId,
    valor: precoMensal,
    nextDueDate: amanha(),
    descricao: `SchedNext — plano ${planoNome}`,
    externalReference: String(empresaId)
  });

  const primeiroPagamento = await asaas.buscarPrimeiroPagamento(assinatura.id);

  return {
    configurado: true,
    checkoutUrl: primeiroPagamento?.invoiceUrl || null,
    gatewayCustomerId: customerId,
    gatewaySubscriptionId: assinatura.id,
    message: 'Assinatura criada! Finalize o pagamento na página que abriu para ativar o plano.'
  };
}

// Usado tanto por "cancelar cobrança" (mantém acesso até proxima_cobranca_em, só impede a
// PRÓXIMA cobrança) quanto por "cancelar plano agora" (downgrade imediato) — nos dois casos o
// efeito no gateway é o mesmo: parar de cobrar. A diferença de UX fica só no lado local
// (routes/pagamentos.js decide se derruba o plano na hora ou deixa rodar até a data).
async function cancelarAssinaturaNoGateway(gatewaySubscriptionId) {
  if (!estaConfigurado() || !gatewaySubscriptionId) return;
  await asaas.cancelarAssinatura(gatewaySubscriptionId);
}

// Recria a assinatura no gateway (reativar cobrança depois de ter cancelado) mantendo a mesma
// data de próxima cobrança já prometida ao cliente.
async function reativarAssinaturaNoGateway({ empresaId, gatewayCustomerId, planoNome, precoMensal, proximaCobrancaEm }) {
  if (!estaConfigurado() || !gatewayCustomerId) return null;

  const nextDueDate = proximaCobrancaEm
    ? new Date(proximaCobrancaEm).toISOString().slice(0, 10)
    : amanha();

  const assinatura = await asaas.criarAssinatura({
    customerId: gatewayCustomerId,
    valor: precoMensal,
    nextDueDate,
    descricao: `SchedNext — plano ${planoNome}`,
    externalReference: String(empresaId)
  });

  return assinatura.id;
}

module.exports = { estaConfigurado, criarCheckout, cancelarAssinaturaNoGateway, reativarAssinaturaNoGateway };
