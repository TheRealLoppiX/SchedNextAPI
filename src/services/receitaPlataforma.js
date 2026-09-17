const supabase = require('../config/supabase');

// Livro-caixa da plataforma (ver sql/2026_plataforma_receitas.sql) — chamado só depois que um
// pagamento de verdade já foi confirmado na API do Mercado Pago (nunca no payload cru de
// webhook). Sempre best-effort: uma falha aqui não pode derrubar a confirmação do pagamento em
// si (o cliente/empresa já pagou de verdade), só faz o registro de receita ficar faltando —
// por isso todo chamador envolve isso em try/catch e só loga o erro.
async function registrarReceitaPlataforma({ tipo, empresaId, valorBruto, valorLiquido, formaPagamento, referenciaExterna, descricao }) {
  // Idempotência: o mesmo pagamento pode passar por aqui mais de uma vez (retry de webhook do
  // Mercado Pago, ou polling do cliente e webhook chegando quase ao mesmo tempo). Sem checar
  // antes, a mesma cobrança viraria duas linhas de receita.
  if (referenciaExterna) {
    const { data: existente } = await supabase
      .from('plataforma_receitas')
      .select('id')
      .eq('tipo', tipo)
      .eq('referencia_externa', referenciaExterna)
      .maybeSingle();
    if (existente) return existente;
  }

  const { data, error } = await supabase
    .from('plataforma_receitas')
    .insert({
      tipo,
      empresa_id: empresaId,
      valor_bruto: valorBruto,
      valor_liquido: valorLiquido,
      forma_pagamento: formaPagamento || null,
      referencia_externa: referenciaExterna || null,
      descricao: descricao || null
    })
    .select('id')
    .single();

  if (error) {
    console.error('Erro ao registrar receita da plataforma:', error);
    return null;
  }
  return data;
}

// Nossa fatia de marketplace (application_fee) num pagamento do Mercado Pago já confirmado —
// deliberadamente separado de mercadopago_fee (custo de processamento do PRÓPRIO Mercado Pago,
// ver services/mercadopago.js:taxaRealDoPagamento), que não é receita nossa.
function taxaMarketplaceDoPagamento(pagamento) {
  return (pagamento?.fee_details || [])
    .filter((d) => d.type === 'application_fee')
    .reduce((acc, d) => acc + Number(d.amount || 0), 0);
}

// Registra a taxa de marketplace de um pagamento TENANT (Pix de atendimento, Pix/cartão de
// mensalidade de cliente final) já confirmado como aprovado. Não registra nada se não houver
// application_fee (plano da empresa com taxa de marketplace zerada, por exemplo) — sem isso
// toda transação criava uma linha de R$0 no livro-caixa.
async function registrarTaxaMarketplace({ pagamento, empresaId, descricao }) {
  const valor = taxaMarketplaceDoPagamento(pagamento);
  if (!(valor > 0)) return null;

  return registrarReceitaPlataforma({
    tipo: 'taxa_marketplace',
    empresaId,
    valorBruto: valor,
    // O application_fee já é o valor líquido de verdade: o Mercado Pago separa essa fatia do
    // pagamento e credita direto na conta da SchedNext, sem outra taxa em cima.
    valorLiquido: valor,
    formaPagamento: pagamento.payment_method_id === 'pix' ? 'pix' : 'cartao',
    referenciaExterna: pagamento.id != null ? String(pagamento.id) : null,
    descricao
  });
}

module.exports = { registrarReceitaPlataforma, registrarTaxaMarketplace, taxaMarketplaceDoPagamento };
