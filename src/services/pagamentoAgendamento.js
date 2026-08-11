const supabase = require('../config/supabase');
const { calcularValorComLimiteAssinante } = require('../utils/limitesAssinatura');

// Calcula o valor final de um atendimento (serviço(s) já vinculados ao agendamento + serviços
// adicionais + produtos vendidos no PDV), respeitando o limite mensal por serviço do plano de
// assinatura do cliente (ver utils/limitesAssinatura.js). Extraído de routes/agendamentos.js
// (POST /admin/finalizar-servico-checkout) pra ser reaproveitado também por routes/mercadopago.js
// (POST /admin/mercadopago/pix/:id) — as duas rotas precisam chegar exatamente no mesmo valor
// pro mesmo agendamento, então não pode haver duas fórmulas divergentes.
//
// registrarConsumo (default false) só deve ser true no fechamento de caixa de verdade — gerar
// um Pix de prévia no PDV não pode debitar a cota de assinatura do cliente antes do atendimento
// ser efetivamente confirmado (se o Pix nunca for pago, ou o admin trocar de forma de pagamento
// depois de gerar o QR, a cota tem que continuar intacta).
async function calcularValorFinalCheckout({ agendamentoId, empresaId, produtosVendidos, servicosAdicionais, registrarConsumo = false }) {
  const { data: agAtual, error: agErr } = await supabase
    .from('agendamentos')
    .select('valor_total, empresa_id, usuario_id, status')
    .eq('id', agendamentoId)
    .maybeSingle();
  if (agErr) throw agErr;
  if (!agAtual || agAtual.empresa_id !== empresaId) return null;

  // Sem essa checagem, reenviar o checkout (duplo clique, retry de rede) descontaria a cota de
  // assinatura do cliente duas vezes pro mesmo atendimento — e gerar um Pix novo pra um
  // atendimento já fechado não faz sentido de qualquer forma, então vale pros dois chamadores.
  if (agAtual.status === 'concluido') {
    const erro = new Error('Este atendimento já foi finalizado.');
    erro.jaConcluido = true;
    throw erro;
  }

  const { data: servicosVinculados } = await supabase
    .from('agendamento_servicos')
    .select('servico_id, servicos(id, valor)')
    .eq('agendamento_id', agendamentoId);

  let valorBase;
  let servicosCobertos = [];
  let servicosCobrados = [];
  if (servicosVinculados && servicosVinculados.length > 0) {
    const servicosParaCalculo = servicosVinculados
      .filter((v) => v.servicos)
      .map((v) => ({ id: v.servico_id, valor: v.servicos.valor }));
    ({ valorBase, servicosCobertos, servicosCobrados } = await calcularValorComLimiteAssinante(
      agAtual.usuario_id,
      servicosParaCalculo,
      { registrarConsumo }
    ));
  } else {
    // Agendamentos sem serviço vinculado (ex: encaixe legado que só grava valor_total direto)
    // caem no valor gravado, não tem como recalcular sem saber quais serviços foram feitos.
    valorBase = parseFloat(agAtual?.valor_total || 0);
  }

  const idsServicosAdicionais = (servicosAdicionais || []).map((s) => s.id).filter(Boolean);
  let precoPorServico = {};
  if (idsServicosAdicionais.length > 0) {
    const { data: servicosReais } = await supabase
      .from('servicos')
      .select('id, valor')
      .in('id', idsServicosAdicionais)
      .eq('empresa_id', agAtual.empresa_id);
    precoPorServico = Object.fromEntries((servicosReais || []).map((s) => [s.id, Number(s.valor) || 0]));
  }
  const valorAdicionais = (servicosAdicionais || []).reduce((acc, s) => acc + (precoPorServico[s.id] || 0), 0);

  let valorProdutos = 0;
  if (produtosVendidos && produtosVendidos.length > 0) {
    const idsProdutos = produtosVendidos.map((p) => p.id).filter(Boolean);
    const { data: produtosReais } = await supabase
      .from('produtos')
      .select('id, valor')
      .in('id', idsProdutos)
      .eq('empresa_id', agAtual.empresa_id);
    const precoPorProduto = Object.fromEntries((produtosReais || []).map((p) => [p.id, Number(p.valor) || 0]));
    valorProdutos = produtosVendidos.reduce((acc, p) => {
      const qtd = parseInt(p.quantidade || 1, 10);
      return acc + (precoPorProduto[p.id] || 0) * qtd;
    }, 0);
  }

  return {
    agendamento: agAtual,
    valorFinal: valorBase + valorAdicionais + valorProdutos,
    servicosCobertos,
    servicosCobrados
  };
}

module.exports = { calcularValorFinalCheckout };
