const supabase = require('../config/supabase');

// Calcula quanto de um conjunto de serviços já está coberto pelo plano de assinatura que o
// cliente tem COM O NEGÓCIO (tabela planos_assinatura/plano_servicos — não confundir com o
// plano da PLATAFORMA SchedNext, que é outra tabela, planos_plataforma). Serviços inclusos no
// plano do assinante saem de graça; qualquer serviço fora do plano continua cobrado normal.
async function calcularValorComDescontoAssinante(usuarioId, servicos) {
  const valorCheio = servicos.reduce((acc, s) => acc + Number(s.valor || 0), 0);
  if (!usuarioId) return valorCheio;

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('assinante, plano_id')
    .eq('id', usuarioId)
    .maybeSingle();

  if (!usuario?.assinante || !usuario.plano_id) return valorCheio;

  const { data: planoServicos } = await supabase
    .from('plano_servicos')
    .select('servico_id')
    .eq('plano_id', usuario.plano_id);

  const idsInclusos = new Set((planoServicos || []).map((r) => r.servico_id));
  return servicos.reduce((acc, s) => acc + (idsInclusos.has(s.id) ? 0 : Number(s.valor || 0)), 0);
}

module.exports = { calcularValorComDescontoAssinante };
