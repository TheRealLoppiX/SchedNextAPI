const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { criarPagamentoBoleto } = require('../services/mercadopago');
const {
  contaPagarSchema,
  contaPagarBaixaSchema,
  contaReceberSchema,
  contaReceberBaixaSchema,
  contaReceberBoletoSchema,
  contaReceberEnviarCobrancaSchema,
  lancamentoEmMassaSchema,
  plataformaConfiguracaoSchema
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

// Dia do mês (fuso de Brasília) de um instante UTC real — usado como âncora de cobrança de uma
// empresa: o dia em que ela fez o PRIMEIRO pagamento da assinatura da plataforma nunca muda,
// mesmo que proxima_cobranca_em tenha sido ajustado manualmente depois (carência, correção etc,
// ver PUT /super-admin/empresas/:id/vencimento em superAdminPlataforma.js).
function diaLocal(isoInstant) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', day: '2-digit' }).format(new Date(isoInstant)));
}

// Aplica um dia-âncora (1-31) a uma competência "AAAA-MM", grudando no último dia do mês quando
// o mês de destino é mais curto (ex: âncora dia 31 numa competência de fevereiro vira 28/29).
function dataPrevistaPorAncora(diaAncora, competenciaAnoMes) {
  const [ano, mes] = competenciaAnoMes.split('-').map(Number);
  const ultimoDiaDoMes = new Date(ano, mes, 0).getDate();
  const dia = Math.min(diaAncora || 1, ultimoDiaDoMes);
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
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
  const { status, categoria, competencia, dataInicio, dataFim, busca } = req.query;

  let query = supabase.from('contas_pagar').select('*').order('data_vencimento', { ascending: true });
  if (categoria) query = query.eq('categoria', categoria);
  if (competencia && /^\d{4}-\d{2}$/.test(competencia)) query = query.eq('competencia', `${competencia}-01`);
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

// Data (criado_em) do PRIMEIRO pagamento de assinatura confirmado de cada empresa (ver
// sql/2026_plataforma_receitas.sql) — âncora da cobrança dela, que nunca muda mesmo que
// proxima_cobranca_em seja ajustado manualmente depois. Uma query filtrada por empresa_id IN
// (...), não uma varredura da tabela inteira.
async function buscarPrimeirosPagamentos(empresaIds) {
  if (!empresaIds.length) return {};
  const { data } = await supabase
    .from('plataforma_receitas')
    .select('empresa_id, criado_em')
    .eq('tipo', 'assinatura_plataforma')
    .in('empresa_id', empresaIds)
    .order('criado_em', { ascending: true });

  const primeiros = {};
  for (const r of data || []) {
    if (!primeiros[r.empresa_id]) primeiros[r.empresa_id] = r.criado_em;
  }
  return primeiros;
}

// Empresas com assinatura de plano pago ativa, pra popular o vínculo rápido de contas a
// receber. dia_ancora é o dia do mês do primeiro pagamento de cada uma (fallback: dia de
// proxima_cobranca_em, pra empresa sem pagamento confirmado ainda, ex: cortesia por chave) —
// usado pra calcular a data prevista de qualquer competência (ver dataPrevistaPorAncora acima),
// em vez de proxima_cobranca_em bruto, que pode ter sido alterado manualmente.
router.get('/super-admin/contas-receber/empresas-sugeridas', async (req, res) => {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, nome, email, status_assinatura, proxima_cobranca_em, plano_plataforma:plano_plataforma_id(nome, preco_mensal)')
    .eq('status_assinatura', 'ativa')
    .order('proxima_cobranca_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao buscar empresas.' });
  const empresasPagas = data.filter((e) => Number(e.plano_plataforma?.preco_mensal) > 0);

  const primeirosPagamentos = await buscarPrimeirosPagamentos(empresasPagas.map((e) => e.id));

  res.json(empresasPagas.map((e) => ({
    ...e,
    dia_ancora: primeirosPagamentos[e.id] ? diaLocal(primeirosPagamentos[e.id]) : (e.proxima_cobranca_em ? diaLocal(e.proxima_cobranca_em) : 1)
  })));
});

// Lançamento em massa: cria uma conta a receber pra cada empresa com plano pago ativo que ainda
// não tem lançamento nessa competência, usando o valor do plano e a data prevista no dia-âncora
// de cada uma (ver dataPrevistaPorAncora/buscarPrimeirosPagamentos acima) — evita ter que criar
// uma por uma toda vez que fecha o mês.
router.post('/super-admin/contas-receber/lancamento-em-massa', validate(lancamentoEmMassaSchema), async (req, res) => {
  const { competencia } = req.body;
  const competenciaData = `${competencia}-01`;

  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id, nome, email, status_assinatura, plano_plataforma:plano_plataforma_id(nome, preco_mensal)')
    .eq('status_assinatura', 'ativa');
  if (error) return res.status(500).json({ error: 'Erro ao buscar empresas.' });

  const empresasPagas = empresas.filter((e) => Number(e.plano_plataforma?.preco_mensal) > 0);
  if (!empresasPagas.length) return res.json({ message: 'Nenhuma empresa com plano pago ativo.', criadas: 0, ignoradas: 0 });

  const ids = empresasPagas.map((e) => e.id);
  const [primeirosPagamentos, { data: existentes, error: errExistentes }] = await Promise.all([
    buscarPrimeirosPagamentos(ids),
    supabase.from('contas_receber').select('empresa_id').eq('competencia', competenciaData).in('empresa_id', ids)
  ]);
  if (errExistentes) return res.status(500).json({ error: 'Erro ao verificar lançamentos já existentes.' });

  const jaLancadas = new Set((existentes || []).map((c) => c.empresa_id));
  const linhasNovas = empresasPagas
    .filter((e) => !jaLancadas.has(e.id))
    .map((e) => ({
      empresa_id: e.id,
      pagador_nome: e.nome,
      pagador_email: e.email || null,
      descricao: `Assinatura de plataforma - ${e.plano_plataforma?.nome || ''}`,
      valor: e.plano_plataforma.preco_mensal,
      competencia: competenciaData,
      data_prevista: dataPrevistaPorAncora(primeirosPagamentos[e.id] ? diaLocal(primeirosPagamentos[e.id]) : 1, competencia)
    }));

  if (!linhasNovas.length) {
    return res.json({ message: 'Todas as empresas já têm lançamento nessa competência.', criadas: 0, ignoradas: jaLancadas.size });
  }

  const { data: inseridas, error: errInsercao } = await supabase.from('contas_receber').insert(linhasNovas).select();
  if (errInsercao) return res.status(500).json({ error: 'Erro ao lançar as contas em massa.' });

  res.json({
    message: `${inseridas.length} conta(s) lançada(s)${jaLancadas.size ? `, ${jaLancadas.size} já existiam nessa competência` : ''}.`,
    criadas: inseridas.length,
    ignoradas: jaLancadas.size
  });
});

router.get('/super-admin/contas-receber', async (req, res) => {
  const { status, empresa_id, competencia, dataInicio, dataFim, busca } = req.query;

  let query = supabase
    .from('contas_receber')
    .select('*, empresas(nome)')
    .order('data_prevista', { ascending: true });
  if (empresa_id) query = query.eq('empresa_id', empresa_id);
  if (competencia && /^\d{4}-\d{2}$/.test(competencia)) query = query.eq('competencia', `${competencia}-01`);
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

// --- Cobrança de verdade (boleto + e-mail) de contas a receber (ver
// sql/2026_contas_receber_cobranca.sql) — nota fiscal e WhatsApp ficam de fora por enquanto
// (nota fiscal exige contratar provedor externo; WhatsApp exige uma instância própria da
// plataforma, ainda não provisionada, ver GET/PUT /super-admin/configuracoes abaixo).

function formatarDataBr(dataStr) {
  if (!dataStr) return '-';
  const [ano, mes, dia] = dataStr.split('-');
  return `${dia}/${mes}/${ano}`;
}

router.post('/super-admin/contas-receber/:id/gerar-boleto', validate(contaReceberBoletoSchema), async (req, res) => {
  if (!process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Cobrança via Mercado Pago não configurada na plataforma.' });
  }

  const { data: conta, error: errBusca } = await supabase.from('contas_receber').select('*').eq('id', req.params.id).maybeSingle();
  if (errBusca) return res.status(500).json({ error: 'Erro ao buscar a conta a receber.' });
  if (!conta) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
  if (!conta.pagador_email) return res.status(400).json({ error: 'Preencha o e-mail do pagador antes de gerar o boleto.' });

  // Salva os dados de identificação/endereço na hora, mesmo que a emissão em si falhe lá na
  // frente — assim o admin não perde o que já digitou numa nova tentativa.
  await supabase.from('contas_receber').update(req.body).eq('id', conta.id);

  try {
    const pagamento = await criarPagamentoBoleto({
      accessToken: process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN,
      valor: conta.valor,
      descricao: conta.descricao,
      externalReference: `conta_receber_${conta.id}`,
      dataVencimentoIso: `${conta.data_prevista}T23:59:59-03:00`,
      payer: {
        email: conta.pagador_email,
        nome: conta.pagador_nome,
        documento: req.body.pagador_documento,
        cep: req.body.pagador_cep,
        endereco: req.body.pagador_endereco,
        numero: req.body.pagador_numero,
        bairro: req.body.pagador_bairro,
        cidade: req.body.pagador_cidade,
        uf: req.body.pagador_uf
      }
    });

    const { data: atualizada, error } = await supabase
      .from('contas_receber')
      .update({
        mercadopago_payment_id: String(pagamento.id),
        boleto_url: pagamento.transaction_details?.external_resource_url || null,
        boleto_codigo_barras: pagamento.barcode?.content || null,
        boleto_gerado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString()
      })
      .eq('id', conta.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: 'Boleto gerado, mas houve um erro ao salvar os dados na conta.' });
    res.json({ message: 'Boleto gerado com sucesso.', conta: atualizada });
  } catch (err) {
    console.error('Erro ao gerar boleto no Mercado Pago:', err.mercadoPagoErrors || err);
    res.status(502).json({ error: err.message || 'Erro ao gerar o boleto no Mercado Pago.' });
  }
});

router.post('/super-admin/contas-receber/:id/enviar-cobranca', validate(contaReceberEnviarCobrancaSchema), async (req, res) => {
  const { data: conta, error: errBusca } = await supabase.from('contas_receber').select('*').eq('id', req.params.id).maybeSingle();
  if (errBusca) return res.status(500).json({ error: 'Erro ao buscar a conta a receber.' });
  if (!conta) return res.status(404).json({ error: 'Conta a receber não encontrada.' });
  if (!conta.pagador_email) return res.status(400).json({ error: 'Preencha o e-mail do pagador antes de enviar a cobrança.' });

  const linhasBoleto = conta.boleto_url
    ? `<p style="margin: 12px 0;"><a href="${conta.boleto_url}" style="color:#2554eb;">Clique aqui para ver o boleto</a></p>
       ${conta.boleto_codigo_barras ? `<p style="margin:0;font-size:13px;color:#4b5563;">Linha digitável: <strong>${conta.boleto_codigo_barras}</strong></p>` : ''}`
    : '';

  try {
    await transporter.sendMail({
      to: conta.pagador_email,
      subject: `Cobrança SchedNext - ${conta.descricao}`,
      html: emailHtml({
        titulo: `Olá, ${conta.pagador_nome}!`,
        mensagemHtml: `
          <p style="margin: 0 0 4px;">${req.body.mensagem || 'Segue a cobrança referente a:'} <strong>${conta.descricao}</strong></p>
          <p style="margin: 12px 0; font-size: 15px;"><strong>Valor:</strong> R$ ${Number(conta.valor).toFixed(2)}<br><strong>Vencimento:</strong> ${formatarDataBr(conta.data_prevista)}</p>
          ${linhasBoleto}
        `
      })
    });
  } catch (err) {
    console.error('Erro ao enviar e-mail de cobrança:', err);
    return res.status(502).json({ error: 'Não foi possível enviar o e-mail de cobrança.' });
  }

  const { data: atualizada, error } = await supabase
    .from('contas_receber')
    .update({ cobranca_enviada_em: new Date().toISOString() })
    .eq('id', conta.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'E-mail enviado, mas houve um erro ao registrar o envio.' });

  res.json({ message: 'Cobrança enviada por e-mail.', conta: atualizada });
});

// --- Configurações gerais da plataforma (ver sql/2026_plataforma_configuracoes.sql) —
// cadastro genérico de chave/valor, hoje usado pro número de WhatsApp próprio da SchedNext
// (ainda sem envio automático, só registro pra quando essa instância for provisionada).

router.get('/super-admin/configuracoes', async (req, res) => {
  const { data, error } = await supabase.from('plataforma_configuracoes').select('chave, valor');
  if (error) return res.status(500).json({ error: 'Erro ao buscar configurações.' });
  res.json(Object.fromEntries(data.map((c) => [c.chave, c.valor])));
});

router.put('/super-admin/configuracoes', validate(plataformaConfiguracaoSchema), async (req, res) => {
  const { chave, valor } = req.body;
  const { data, error } = await supabase
    .from('plataforma_configuracoes')
    .upsert({ chave, valor: valor || null, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Erro ao salvar configuração.' });
  res.json({ message: 'Configuração salva.', configuracao: data });
});

module.exports = router;
