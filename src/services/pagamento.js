// Adapter de cobrança. Ainda não há conta/credenciais reais de nenhum gateway (o plano
// recomenda Mercado Pago/Asaas/Pagar.me por causa do PIX; decisão final fica pra quando
// formos ligar a cobrança de verdade). Este arquivo existe pra já ter UM lugar só que muda
// quando isso acontecer, em vez de espalhar `if (MERCADOPAGO_ACCESS_TOKEN)` pelo código.
//
// Até lá, empresas em plano pago entram como `status_assinatura = 'trial'` (ver
// routes/empresasPublico.js) e não são bloqueadas. Cobrar de verdade sem gateway configurado
// não é possível, e bloquear acesso sem nunca ter cobrado seria pior que não cobrar.

function estaConfigurado() {
  return Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN);
}

async function criarCheckout({ empresaId, planoId, planoNome, precoMensal }) {
  if (!estaConfigurado()) {
    return {
      configurado: false,
      message: 'Cobrança automática ainda não está disponível. Seu plano fica em modo de teste até a cobrança ser ativada, fale com o suporte.'
    };
  }

  // TODO(gateway real): integrar a criação de preferência/checkout do gateway escolhido
  // (Mercado Pago Assinaturas, Asaas ou Pagar.me) aqui, usando empresaId como referência
  // externa e devolvendo a URL de checkout pro frontend redirecionar.
  throw new Error('Gateway de pagamento configurado mas integração ainda não implementada.');
}

module.exports = { estaConfigurado, criarCheckout };
