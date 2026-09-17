const express = require('express');
const supabase = require('../config/supabase');

const router = express.Router();

// Relatório financeiro DA PLATAFORMA (faturamento/receita líquida/taxas da SchedNext), separado
// do relatório de cada barbearia (ver routes/relatorios.js). Alimentado por
// plataforma_receitas (ver sql/2026_plataforma_receitas.sql e services/receitaPlataforma.js) —
// só existe dado a partir do dia em que essa tabela passou a ser populada; não há como
// reconstruir receita anterior.
//
// Brasil não tem mais horário de verão desde 2019 (UTC-3 fixo o ano todo), então converter
// data local <-> instante UTC aqui é só somar/subtrair 3h, sem precisar de biblioteca de fuso.

function inicioDoDiaLocalUTC(dataStr) {
  return new Date(`${dataStr}T00:00:00-03:00`);
}

function fimDoDiaLocalUTC(dataStr) {
  return new Date(`${dataStr}T23:59:59.999-03:00`);
}

// Bucket de agrupamento (dia/mês/ano) em horário de Brasília a partir de um instante UTC real
// (criado_em é timestamptz de verdade, diferente do data_hora "ingênuo" de agendamentos —
// ver routes/relatorios.js). Intl.DateTimeFormat com locale en-CA devolve "AAAA-MM-DD" pronto.
function chaveAgrupamento(isoInstant, agrupamento) {
  const dataLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(isoInstant));

  if (agrupamento === 'ano') return dataLocal.slice(0, 4);
  if (agrupamento === 'mes') return dataLocal.slice(0, 7);
  return dataLocal;
}

function formatarDataLocalHoje() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

const TIPOS = ['assinatura_plataforma', 'taxa_marketplace'];

router.get('/super-admin/financeiro', async (req, res) => {
  const hoje = formatarDataLocalHoje();
  const dataInicio = req.query.dataInicio || `${hoje.slice(0, 7)}-01`;
  const dataFim = req.query.dataFim || hoje;
  const agrupamento = ['dia', 'mes', 'ano'].includes(req.query.agrupamento) ? req.query.agrupamento : 'dia';

  const { data: receitas, error } = await supabase
    .from('plataforma_receitas')
    .select('tipo, empresa_id, valor_bruto, valor_liquido, forma_pagamento, criado_em, empresas(nome)')
    .gte('criado_em', inicioDoDiaLocalUTC(dataInicio).toISOString())
    .lte('criado_em', fimDoDiaLocalUTC(dataFim).toISOString())
    .order('criado_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao calcular o financeiro da plataforma.' });

  const porTipo = { assinatura_plataforma: { bruto: 0, liquido: 0, qtd: 0 }, taxa_marketplace: { bruto: 0, liquido: 0, qtd: 0 } };
  const seriePorChave = {};
  const porEmpresa = {};
  let faturamentoBruto = 0;
  let receitaLiquida = 0;

  for (const r of receitas) {
    const bruto = Number(r.valor_bruto);
    const liquido = Number(r.valor_liquido);
    faturamentoBruto += bruto;
    receitaLiquida += liquido;

    if (TIPOS.includes(r.tipo)) {
      porTipo[r.tipo].bruto += bruto;
      porTipo[r.tipo].liquido += liquido;
      porTipo[r.tipo].qtd += 1;
    }

    const chave = chaveAgrupamento(r.criado_em, agrupamento);
    if (!seriePorChave[chave]) seriePorChave[chave] = { periodo: chave, bruto: 0, liquido: 0, qtd: 0 };
    seriePorChave[chave].bruto += bruto;
    seriePorChave[chave].liquido += liquido;
    seriePorChave[chave].qtd += 1;

    const nomeEmpresa = r.empresas?.nome || `Empresa #${r.empresa_id}`;
    if (!porEmpresa[nomeEmpresa]) porEmpresa[nomeEmpresa] = { empresa: nomeEmpresa, bruto: 0, liquido: 0, qtd: 0 };
    porEmpresa[nomeEmpresa].bruto += bruto;
    porEmpresa[nomeEmpresa].liquido += liquido;
    porEmpresa[nomeEmpresa].qtd += 1;
  }

  const descontosValor = faturamentoBruto - receitaLiquida;

  res.json({
    periodo: { inicio: dataInicio, fim: dataFim },
    agrupamento,
    resumo: {
      faturamento_bruto: Number(faturamentoBruto.toFixed(2)),
      receita_liquida: Number(receitaLiquida.toFixed(2)),
      descontos_valor: Number(descontosValor.toFixed(2)),
      descontos_pct: faturamentoBruto > 0 ? Number((descontosValor / faturamentoBruto * 100).toFixed(2)) : 0,
      quantidade_transacoes: receitas.length,
      por_tipo: {
        assinatura_plataforma: {
          bruto: Number(porTipo.assinatura_plataforma.bruto.toFixed(2)),
          liquido: Number(porTipo.assinatura_plataforma.liquido.toFixed(2)),
          qtd: porTipo.assinatura_plataforma.qtd
        },
        taxa_marketplace: {
          bruto: Number(porTipo.taxa_marketplace.bruto.toFixed(2)),
          liquido: Number(porTipo.taxa_marketplace.liquido.toFixed(2)),
          qtd: porTipo.taxa_marketplace.qtd
        }
      }
    },
    serie_periodo: Object.values(seriePorChave)
      .map((s) => ({ periodo: s.periodo, bruto: Number(s.bruto.toFixed(2)), liquido: Number(s.liquido.toFixed(2)), qtd: s.qtd }))
      .sort((a, b) => a.periodo.localeCompare(b.periodo)),
    top_empresas: Object.values(porEmpresa)
      .map((e) => ({ empresa: e.empresa, bruto: Number(e.bruto.toFixed(2)), liquido: Number(e.liquido.toFixed(2)), qtd: e.qtd }))
      .sort((a, b) => b.bruto - a.bruto)
      .slice(0, 10),
    detalhamento: receitas.map((r) => ({
      criado_em: r.criado_em,
      empresa: r.empresas?.nome || `Empresa #${r.empresa_id}`,
      tipo: r.tipo,
      forma_pagamento: r.forma_pagamento,
      valor_bruto: Number(r.valor_bruto),
      valor_liquido: Number(r.valor_liquido)
    }))
  });
});

module.exports = router;
