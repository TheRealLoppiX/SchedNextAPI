const supabase = require('../config/supabase');
const mercadopago = require('./mercadopago');
const { buscarCampanhaDaEmpresa, precoDoCiclo, precoCheioDaEmpresa } = require('./precificacaoPlataforma');

// Garante que a assinatura de CARTÃO (preapproval) de uma empresa em campanha promocional está
// com o valor certo pra PRÓXIMA mensalidade (ex: depois do 1º mês a R$ 9,90, o 2º já tem que
// vir no preço cheio). O Mercado Pago repete sozinho o último valor configurado, então alguém
// precisa trocá-lo entre um mês e outro.
//
// Nunca cria cobrança: só altera o valor da assinatura que já existe (PUT /preapproval), que o
// Mercado Pago usa na próxima data de cobrança dele. Chamar isto várias vezes é seguro — se o
// valor já estiver certo, não faz nada.
//
// O mês atual vem da contagem de mensalidades realmente debitadas no Mercado Pago, não de
// ciclo_cobranca_atual: assim um webhook perdido ou uma falha ao atualizar o valor são corrigidos
// na próxima passada (webhook do pagamento seguinte ou cron/sincronizarValorCartao.js).
async function sincronizarValorCartaoCampanha({ empresaId, preapprovalId, campanhaId, planoId }) {
  if (!process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN || !preapprovalId || !campanhaId) return null;
  const accessToken = process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN;

  const preapproval = await mercadopago.buscarPreapproval({ accessToken, preapprovalId });
  // Só assinatura autorizada tem próxima cobrança; pendente/pausada/cancelada fica como está.
  if (preapproval?.status !== 'authorized') return null;

  const [pagos, campanha, { data: plano }] = await Promise.all([
    mercadopago.contarPagamentosAutorizadosProcessados({ accessToken, preapprovalId }),
    buscarCampanhaDaEmpresa(campanhaId),
    supabase.from('planos_plataforma').select('preco_mensal').eq('id', planoId).maybeSingle()
  ]);

  // A 1ª mensalidade é sempre a que o cliente viu e autorizou no checkout — nunca mexe nela,
  // nem se a campanha for desligada entre a autorização e a primeira cobrança.
  if (pagos === 0) return null;

  const precoCheio = await precoCheioDaEmpresa(empresaId, plano?.preco_mensal);
  if (!(precoCheio > 0)) return null;

  const proximoMes = pagos + 1;
  const esperado = precoDoCiclo(campanha, proximoMes, precoCheio);
  const atual = Number(preapproval.auto_recurring?.transaction_amount);
  if (Number.isFinite(atual) && Math.abs(atual - esperado) < 0.005) return { alterado: false, valor: atual };

  await mercadopago.atualizarValorPreapproval({ accessToken, preapprovalId, valor: esperado });
  console.log(`Valor da assinatura (cartão) da empresa ${empresaId} ajustado de ${atual} para ${esperado} (mês ${proximoMes}).`);
  return { alterado: true, valor: esperado };
}

module.exports = { sincronizarValorCartaoCampanha };
