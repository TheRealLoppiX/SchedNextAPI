const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const {
  contaPagarSchema,
  contaPagarBaixaSchema,
  contaReceberSchema,
  contaReceberBaixaSchema
} = require('../schemas');

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

// --- Contas a Pagar e a Receber (ver sql/2026_contas_pagar_receber.sql) ---
//
// Lançamento manual de despesas (contas_pagar) e valores previstos a receber (contas_receber),
// diferente de plataforma_receitas acima que só guarda cobrança JÁ confirmada. "Atrasado" nunca
// é gravado no banco — é sempre derivado (pendente + vencimento no passado) na hora de responder,
// pra não depender de um cron rodando todo dia só pra manter esse status em dia.

function comStatusEfetivo(linha, campoData) {
  const hoje = formatarDataLocalHoje();
  const atrasado = linha.status === 'pendente' && linha[campoData] && linha[campoData] < hoje;
  return { ...linha, status_efetivo: atrasado ? 'atrasado' : linha.status };
}

function resumoContas(linhas, campoValor = 'valor') {
  const resumo = {
    valor_total: 0, qtd_total: linhas.length,
    pendente: { valor: 0, qtd: 0 },
    atrasado: { valor: 0, qtd: 0 },
    concluido: { valor: 0, qtd: 0 },
    cancelado: { valor: 0, qtd: 0 }
  };
  for (const l of linhas) {
    const valor = Number(l[campoValor]);
    resumo.valor_total += valor;
    const chave = l.status_efetivo === 'atrasado' ? 'atrasado'
      : l.status_efetivo === 'pendente' ? 'pendente'
      : l.status_efetivo === 'cancelado' ? 'cancelado'
      : 'concluido';
    resumo[chave].valor += valor;
    resumo[chave].qtd += 1;
  }
  resumo.valor_total = Number(resumo.valor_total.toFixed(2));
  for (const chave of ['pendente', 'atrasado', 'concluido', 'cancelado']) {
    resumo[chave].valor = Number(resumo[chave].valor.toFixed(2));
  }
  return resumo;
}

router.get('/super-admin/contas-pagar', async (req, res) => {
  const { status, categoria, dataInicio, dataFim, busca } = req.query;

  let query = supabase.from('contas_pagar').select('*').order('data_vencimento', { ascending: true });
  if (categoria) query = query.eq('categoria', categoria);
  if (dataInicio) query = query.gte('data_vencimento', dataInicio);
  if (dataFim) query = query.lte('data_vencimento', dataFim);
  // Remove vírgula/parênteses antes de interpolar no `.or()` (mesmo cuidado de
  // routes/superAdminPlataforma.js): o PostgREST separa condições por vírgula.
  if (busca) {
    const buscaSegura = String(busca).replace(/[,()]/g, '');
    query = query.or(`descricao.ilike.%${buscaSegura}%,beneficiario_nome.ilike.%${buscaSegura}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar contas a pagar.' });

  let itens = data.map((l) => comStatusEfetivo(l, 'data_vencimento'));
  if (status) itens = itens.filter((l) => l.status_efetivo === status);

  res.json({ resumo: resumoContas(itens), itens });
});

router.post('/super-admin/contas-pagar', validate(contaPagarSchema), async (req, res) => {
  const { data, error } = await supabase.from('contas_pagar').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: 'Erro ao lançar a conta a pagar.' });
  res.status(201).json({ message: 'Conta a pagar lançada com sucesso.', conta: data });
});

router.put('/super-admin/contas-pagar/:id', validate(contaPagarSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('contas_pagar')
    .update({ ...req.body, atualizado_em: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao atualizar a conta a pagar.' });
  if (!data) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
  res.json({ message: 'Conta a pagar atualizada.', conta: data });
});

router.put('/super-admin/contas-pagar/:id/pagar', validate(contaPagarBaixaSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('contas_pagar')
    .update({
      status: 'pago',
      data_pagamento: req.body.data_pagamento || formatarDataLocalHoje(),
      atualizado_em: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao dar baixa na conta a pagar.' });
  if (!data) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
  res.json({ message: 'Conta marcada como paga.', conta: data });
});

router.put('/super-admin/contas-pagar/:id/cancelar', async (req, res) => {
  const { data, error } = await supabase
    .from('contas_pagar')
    .update({ status: 'cancelado', atualizado_em: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao cancelar a conta a pagar.' });
  if (!data) return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
  res.json({ message: 'Conta a pagar cancelada.', conta: data });
});

router.delete('/super-admin/contas-pagar/:id', async (req, res) => {
  const { error } = await supabase.from('contas_pagar').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir a conta a pagar.' });
  res.json({ message: 'Conta a pagar excluída.' });
});

// Empresas com assinatura de plano pago ativa, pra popular o vínculo rápido de contas a
// receber com a próxima cobrança já conhecida (empresas.proxima_cobranca_em) sem digitar tudo
// de novo à mão.
router.get('/super-admin/contas-receber/empresas-sugeridas', async (req, res) => {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, nome, status_assinatura, proxima_cobranca_em, plano_plataforma:plano_plataforma_id(nome, preco_mensal)')
    .eq('status_assinatura', 'ativa')
    .order('proxima_cobranca_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao buscar empresas.' });
  res.json(data.filter((e) => Number(e.plano_plataforma?.preco_mensal) > 0));
});

router.get('/super-admin/contas-receber', async (req, res) => {
  const { status, empresa_id, dataInicio, dataFim, busca } = req.query;

  let query = supabase
    .from('contas_receber')
    .select('*, empresas(nome)')
    .order('data_prevista', { ascending: true });
  if (empresa_id) query = query.eq('empresa_id', empresa_id);
  if (dataInicio) query = query.gte('data_prevista', dataInicio);
  if (dataFim) query = query.lte('data_prevista', dataFim);
  if (busca) {
    const buscaSegura = String(busca).replace(/[,()]/g, '');
    query = query.or(`descricao.ilike.%${buscaSegura}%,pagador_nome.ilike.%${buscaSegura}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar contas a receber.' });

  let itens = data.map((l) => comStatusEfetivo({ ...l, empresa_nome: l.empresas?.nome || null }, 'data_prevista'));
  if (status) itens = itens.filter((l) => l.status_efetivo === status);
  itens = itens.map(({ empresas, ...resto }) => resto);

  res.json({ resumo: resumoContas(itens), itens });
});

router.post('/super-admin/contas-receber', validate(contaReceberSchema), async (req, res) => {
  const { data, error } = await supabase.from('contas_receber').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: 'Erro ao lançar a conta a receber.' });
  res.status(201).json({ message: 'Conta a receber lançada com sucesso.', conta: data });
});

router.put('/super-admin/contas-receber/:id', validate(contaReceberSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('contas_receber')
    .update({ ...req.body, atualizado_em: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao atualizar a conta a receber.' });
  if (!data) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
  res.json({ message: 'Conta a receber atualizada.', conta: data });
});

router.put('/super-admin/contas-receber/:id/receber', validate(contaReceberBaixaSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('contas_receber')
    .update({
      status: 'recebido',
      data_recebimento: req.body.data_recebimento || formatarDataLocalHoje(),
      atualizado_em: new Date().toISOString()
    })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao dar baixa na conta a receber.' });
  if (!data) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
  res.json({ message: 'Conta marcada como recebida.', conta: data });
});

router.put('/super-admin/contas-receber/:id/cancelar', async (req, res) => {
  const { data, error } = await supabase
    .from('contas_receber')
    .update({ status: 'cancelado', atualizado_em: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao cancelar a conta a receber.' });
  if (!data) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
  res.json({ message: 'Conta a receber cancelada.', conta: data });
});

router.delete('/super-admin/contas-receber/:id', async (req, res) => {
  const { error } = await supabase.from('contas_receber').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir a conta a receber.' });
  res.json({ message: 'Conta a receber excluída.' });
});

module.exports = router;
