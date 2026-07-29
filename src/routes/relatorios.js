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
    const { data: agendamentos, error } = await supabase
      .from('agendamentos')
      .select('id, status, data_hora, valor_total, usuario_id, barbeiro_id, barbeiros(nome)')
      .eq('empresa_id', empresaId)
      .gte('data_hora', `${dataInicio}T00:00:00`)
      .lte('data_hora', `${dataFim}T23:59:59`);

    if (error) throw error;

    const concluidos = (agendamentos || []).filter((a) => a.status === 'concluido');
    const cancelados = (agendamentos || []).filter((a) => a.status === 'cancelado');
    const total = (agendamentos || []).length;

    const faturamentoTotal = concluidos.reduce((acc, a) => acc + Number(a.valor_total || 0), 0);
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

module.exports = router;
