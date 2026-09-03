const express = require('express');
const supabase = require('../config/supabase');
const { permiteRelatoriosAvancados } = require('../utils/limitesPlano');

const router = express.Router();

// Relatórios avançados são um recurso exclusivo do plano Enterprise (ver §3 do plano de
// plataforma, mesmo padrão de gate usado em routes/unidades.js e routes/apiKeys.js).

function formatarDataLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function periodoAnterior(dataInicio, dataFim) {
  const inicio = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  const duracaoDias = Math.max(1, Math.round((fim - inicio) / 86400000) + 1);

  const fimAnterior = new Date(inicio);
  fimAnterior.setDate(fimAnterior.getDate() - 1);
  const inicioAnterior = new Date(fimAnterior);
  inicioAnterior.setDate(inicioAnterior.getDate() - (duracaoDias - 1));

  return { inicio: formatarDataLocal(inicioAnterior), fim: formatarDataLocal(fimAnterior) };
}

router.get('/admin/relatorios/:empresaId', async (req, res) => {
  const empresaId = req.empresaId;

  if (!(await permiteRelatoriosAvancados(empresaId))) {
    return res.status(403).json({ error: 'Relatórios avançados são um recurso exclusivo do plano Enterprise. Fale com o suporte para fazer upgrade.' });
  }

  const hoje = formatarDataLocal(new Date());
  const dataInicio = req.query.dataInicio || hoje;
  const dataFim = req.query.dataFim || hoje;

  try {
    const { data: empresaRow } = await supabase.from('empresas').select('taxas_pagamento').eq('id', empresaId).maybeSingle();
    const taxas = { dinheiro: 0, credito: 0, debito: 0, pix: 0, ...(empresaRow?.taxas_pagamento || {}) };

    const { data: agendamentos, error } = await supabase
      .from('agendamentos')
      .select('id, status, data_hora, valor_total, usuario_id, barbeiro_id, forma_pagamento, barbeiros(nome)')
      .eq('empresa_id', empresaId)
      .gte('data_hora', `${dataInicio}T00:00:00`)
      .lte('data_hora', `${dataFim}T23:59:59`);

    if (error) throw error;

    const concluidos = (agendamentos || []).filter((a) => a.status === 'concluido');
    const cancelados = (agendamentos || []).filter((a) => a.status === 'cancelado');
    const total = (agendamentos || []).length;

    const faturamentoTotal = concluidos.reduce((acc, a) => acc + Number(a.valor_total || 0), 0);
    // Receita líquida: desconta a taxa de maquineta cadastrada (ver routes/financeiro.js) pra
    // cada agendamento, de acordo com a forma de pagamento usada. Agendamentos sem
    // forma_pagamento registrada (histórico antigo, ou fechado sem informar) entram sem desconto.
    const receitaLiquidaTotal = concluidos.reduce((acc, a) => {
      const taxaPct = taxas[a.forma_pagamento] || 0;
      return acc + Number(a.valor_total || 0) * (1 - taxaPct / 100);
    }, 0);
    const ticketMedio = concluidos.length > 0 ? faturamentoTotal / concluidos.length : 0;
    const taxaCancelamento = total > 0 ? (cancelados.length / total) * 100 : 0;

    // Série diária de faturamento (só agendamentos concluídos contam como receita real).
    const porDia = {};
    for (const a of concluidos) {
      const dia = a.data_hora.slice(0, 10);
      if (!porDia[dia]) porDia[dia] = { data: dia, faturamento: 0, quantidade: 0 };
      porDia[dia].faturamento += Number(a.valor_total || 0);
      porDia[dia].quantidade += 1;
    }
    const serieDiaria = Object.values(porDia).sort((a, b) => a.data.localeCompare(b.data));

    // Top profissionais por faturamento, a partir do mesmo conjunto de agendamentos concluídos.
    const porProfissional = {};
    for (const a of concluidos) {
      if (!a.barbeiro_id) continue;
      const nome = a.barbeiros?.nome || 'Sem nome';
      if (!porProfissional[a.barbeiro_id]) porProfissional[a.barbeiro_id] = { nome, quantidade: 0, faturamento: 0 };
      porProfissional[a.barbeiro_id].quantidade += 1;
      porProfissional[a.barbeiro_id].faturamento += Number(a.valor_total || 0);
    }
    const topProfissionais = Object.values(porProfissional).sort((a, b) => b.faturamento - a.faturamento).slice(0, 10);

    // Top serviços: busca os serviços vinculados aos agendamentos concluídos do período.
    const idsConcluidos = concluidos.map((a) => a.id);
    let topServicos = [];
    if (idsConcluidos.length > 0) {
      const { data: vinculos, error: vincErro } = await supabase
        .from('agendamento_servicos')
        .select('servico_id, servicos(nome, valor)')
        .in('agendamento_id', idsConcluidos);

      if (vincErro) throw vincErro;

      const porServico = {};
      for (const v of vinculos || []) {
        if (!v.servico_id || !v.servicos) continue;
        if (!porServico[v.servico_id]) porServico[v.servico_id] = { nome: v.servicos.nome, quantidade: 0, faturamento: 0 };
        porServico[v.servico_id].quantidade += 1;
        porServico[v.servico_id].faturamento += Number(v.servicos.valor || 0);
      }
      topServicos = Object.values(porServico).sort((a, b) => b.faturamento - a.faturamento).slice(0, 10);
    }

    // Comparação com o período imediatamente anterior, de mesma duração.
    const anterior = periodoAnterior(dataInicio, dataFim);
    const { data: agendamentosAnteriores, error: erroAnterior } = await supabase
      .from('agendamentos')
      .select('valor_total, status')
      .eq('empresa_id', empresaId)
      .eq('status', 'concluido')
      .gte('data_hora', `${anterior.inicio}T00:00:00`)
      .lte('data_hora', `${anterior.fim}T23:59:59`);

    if (erroAnterior) throw erroAnterior;

    const faturamentoAnterior = (agendamentosAnteriores || []).reduce((acc, a) => acc + Number(a.valor_total || 0), 0);
    const variacaoFaturamentoPct = faturamentoAnterior > 0
      ? ((faturamentoTotal - faturamentoAnterior) / faturamentoAnterior) * 100
      : (faturamentoTotal > 0 ? 100 : 0);

    // Recorrência: dentre os clientes que fecharam atendimento neste período, quantos já
    // tinham pelo menos um atendimento concluído ANTES do início do período.
    const clientesNoPeriodo = [...new Set(concluidos.map((a) => a.usuario_id).filter(Boolean))];
    let clientesRecorrentes = 0;
    if (clientesNoPeriodo.length > 0) {
      const { data: historico, error: erroHistorico } = await supabase
        .from('agendamentos')
        .select('usuario_id')
        .eq('empresa_id', empresaId)
        .eq('status', 'concluido')
        .in('usuario_id', clientesNoPeriodo)
        .lt('data_hora', `${dataInicio}T00:00:00`);

      if (erroHistorico) throw erroHistorico;
      clientesRecorrentes = new Set((historico || []).map((h) => h.usuario_id)).size;
    }
    const taxaRecorrenciaPct = clientesNoPeriodo.length > 0 ? (clientesRecorrentes / clientesNoPeriodo.length) * 100 : 0;

    res.json({
      periodo: { inicio: dataInicio, fim: dataFim },
      resumo: {
        faturamento_total: faturamentoTotal,
        receita_liquida: Number(receitaLiquidaTotal.toFixed(2)),
        ticket_medio: ticketMedio,
        quantidade_concluidos: concluidos.length,
        taxa_cancelamento: Number(taxaCancelamento.toFixed(1)),
        faturamento_periodo_anterior: faturamentoAnterior,
        variacao_faturamento_pct: Number(variacaoFaturamentoPct.toFixed(1))
      },
      serie_diaria: serieDiaria,
      top_servicos: topServicos,
      top_profissionais: topProfissionais,
      recorrencia: {
        total_clientes_periodo: clientesNoPeriodo.length,
        clientes_recorrentes: clientesRecorrentes,
        taxa_recorrencia_pct: Number(taxaRecorrenciaPct.toFixed(1))
      }
    });
  } catch (err) {
    console.error('Erro ao gerar relatório avançado:', err);
    res.status(500).json({ error: 'Erro ao gerar o relatório.' });
  }
});

// Relatório de comissionamento por profissional. Diferente do relatório geral acima, este NÃO
// é exclusivo do plano Enterprise — comissionamento é uma necessidade operacional básica de
// qualquer negócio com equipe, não um recurso premium.
router.get('/admin/relatorios/comissionamento/:empresaId', async (req, res) => {
  const empresaId = req.empresaId;
  const hoje = formatarDataLocal(new Date());
  const dataInicio = req.query.dataInicio || `${hoje.slice(0, 7)}-01`;
  const dataFim = req.query.dataFim || hoje;

  try {
    const { data: empresaRow } = await supabase.from('empresas').select('taxas_pagamento').eq('id', empresaId).maybeSingle();
    const taxas = { dinheiro: 0, credito: 0, debito: 0, pix: 0, ...(empresaRow?.taxas_pagamento || {}) };

    const { data: profissionais, error: erroProf } = await supabase
      .from('barbeiros')
      .select('id, nome, percentual_comissao')
      .eq('empresa_id', empresaId);
    if (erroProf) throw erroProf;

    const nomePorProfissional = Object.fromEntries(profissionais.map((p) => [p.id, p.nome]));
    const percentualPorProfissional = Object.fromEntries(profissionais.map((p) => [p.id, Number(p.percentual_comissao) || 0]));

    const { data: agendamentos, error } = await supabase
      .from('agendamentos')
      .select('id, barbeiro_id, usuario_id, valor_total, forma_pagamento, data_hora')
      .eq('empresa_id', empresaId)
      .eq('status', 'concluido')
      .gte('data_hora', `${dataInicio}T00:00:00`)
      .lte('data_hora', `${dataFim}T23:59:59`);
    if (error) throw error;

    // Rateio de cliente assinante: o atendimento em si custa R$0 pro assinante (serviço incluso
    // no plano, ver PENDENCIAS.md/bug corrigido), mas ele PAGOU pela mensalidade — então, só
    // pra fins de comissão, atribuímos ao profissional a fatia proporcional do valor do plano
    // (preço mensal ÷ quantidade de visitas concluídas naquele mês-calendário do cliente).
    const idsClientes = [...new Set(agendamentos.map((a) => a.usuario_id).filter(Boolean))];
    const precoAssinaturaPorCliente = {};
    const nomePorCliente = {};
    if (idsClientes.length > 0) {
      const { data: usuarios } = await supabase.from('usuarios').select('id, nome, assinante, plano_id').in('id', idsClientes);
      const planoIds = [...new Set((usuarios || []).filter((u) => u.assinante && u.plano_id).map((u) => u.plano_id))];
      let precoPorPlano = {};
      if (planoIds.length > 0) {
        const { data: planos } = await supabase.from('planos_assinatura').select('id, preco').in('id', planoIds);
        precoPorPlano = Object.fromEntries((planos || []).map((p) => [p.id, Number(p.preco) || 0]));
      }
      for (const u of usuarios || []) {
        nomePorCliente[u.id] = u.nome;
        if (u.assinante && u.plano_id && precoPorPlano[u.plano_id] != null) {
          precoAssinaturaPorCliente[u.id] = precoPorPlano[u.plano_id];
        }
      }
    }

    // Serviços vinculados a cada agendamento — pra deixar rastreável exatamente o que o
    // profissional fez em cada atendimento que compôs a comissão dele, não só o valor agregado.
    const idsAgendamentos = agendamentos.map((a) => a.id);
    const servicosPorAgendamento = {};
    if (idsAgendamentos.length > 0) {
      const { data: vinculos, error: erroVinculos } = await supabase
        .from('agendamento_servicos')
        .select('agendamento_id, servicos(nome)')
        .in('agendamento_id', idsAgendamentos);
      if (erroVinculos) throw erroVinculos;
      for (const v of vinculos || []) {
        if (!v.servicos) continue;
        if (!servicosPorAgendamento[v.agendamento_id]) servicosPorAgendamento[v.agendamento_id] = [];
        servicosPorAgendamento[v.agendamento_id].push(v.servicos.nome);
      }
    }

    const visitasPorClienteMes = {};
    for (const a of agendamentos) {
      if (!a.usuario_id || precoAssinaturaPorCliente[a.usuario_id] == null) continue;
      const chave = `${a.usuario_id}-${a.data_hora.slice(0, 7)}`;
      visitasPorClienteMes[chave] = (visitasPorClienteMes[chave] || 0) + 1;
    }

    const porProfissional = {};
    for (const a of agendamentos) {
      if (!a.barbeiro_id) continue;

      const ehAssinante = a.usuario_id && precoAssinaturaPorCliente[a.usuario_id] != null;
      let receita = Number(a.valor_total || 0);
      let visitas = 1;
      if (ehAssinante) {
        const chave = `${a.usuario_id}-${a.data_hora.slice(0, 7)}`;
        visitas = visitasPorClienteMes[chave] || 1;
        receita = precoAssinaturaPorCliente[a.usuario_id] / visitas;
      }

      const taxaPct = taxas[a.forma_pagamento] || 0;
      const receitaLiquida = receita * (1 - taxaPct / 100);
      const percentual = percentualPorProfissional[a.barbeiro_id] || 0;
      const comissao = receitaLiquida * (percentual / 100);

      if (!porProfissional[a.barbeiro_id]) {
        porProfissional[a.barbeiro_id] = {
          id: a.barbeiro_id,
          nome: nomePorProfissional[a.barbeiro_id] || 'Sem nome',
          percentual_comissao: percentual,
          quantidade: 0,
          receita_bruta: 0,
          receita_liquida: 0,
          comissao: 0,
          itens: []
        };
      }
      porProfissional[a.barbeiro_id].quantidade += 1;
      porProfissional[a.barbeiro_id].receita_bruta += Number(a.valor_total || 0);
      porProfissional[a.barbeiro_id].receita_liquida += receitaLiquida;
      porProfissional[a.barbeiro_id].comissao += comissao;
      porProfissional[a.barbeiro_id].itens.push({
        data: a.data_hora,
        cliente: a.usuario_id ? (nomePorCliente[a.usuario_id] || 'Cliente') : 'Cliente avulso',
        servicos: servicosPorAgendamento[a.id] || [],
        tipo: ehAssinante ? 'assinante' : 'avulso',
        visitas_no_mes: ehAssinante ? visitas : null,
        valor_base: Number(a.valor_total || 0),
        valor_atribuido: Number(receita.toFixed(2)),
        receita_liquida: Number(receitaLiquida.toFixed(2)),
        comissao: Number(comissao.toFixed(2))
      });
    }

    const profissionaisFormatado = Object.values(porProfissional)
      .map((p) => ({
        ...p,
        receita_bruta: Number(p.receita_bruta.toFixed(2)),
        receita_liquida: Number(p.receita_liquida.toFixed(2)),
        comissao: Number(p.comissao.toFixed(2)),
        itens: p.itens.sort((a, b) => b.data.localeCompare(a.data))
      }))
      .sort((a, b) => b.comissao - a.comissao);

    res.json({ periodo: { inicio: dataInicio, fim: dataFim }, taxas_pagamento: taxas, profissionais: profissionaisFormatado });
  } catch (err) {
    console.error('Erro ao gerar relatório de comissionamento:', err);
    res.status(500).json({ error: 'Erro ao gerar o relatório de comissionamento.' });
  }
});

module.exports = router;
