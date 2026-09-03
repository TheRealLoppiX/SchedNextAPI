const express = require('express');
const supabase = require('../config/supabase');
const { permiteRelatoriosAvancados } = require('../utils/limitesPlano');
const { calcularInicioCiclo, calcularFimCiclo } = require('../utils/limitesAssinatura');

const router = express.Router();

// Relatórios avançados são um recurso exclusivo do plano Enterprise (ver §3 do plano de
// plataforma, mesmo padrão de gate usado em routes/unidades.js e routes/apiKeys.js).

function formatarDataLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Pix só passa taxa de gateway pra frente quando foi de fato cobrado via QR Code do Mercado
// Pago (pagamento_status só vira 'pago' pela confirmação real do gateway, ver
// routes/mercadopago.js). Pix registrado manualmente no checkout (ex: cliente pagou na chave
// Pix pessoal da barbearia, fora da plataforma) não passa pelo MP, então não tem taxa nenhuma
// pra descontar — mesmo que exista uma taxa de Pix cadastrada pra outros casos.
function taxaParaForma(formaPagamento, pagamentoStatus, taxas) {
  if (formaPagamento === 'pix' && pagamentoStatus !== 'pago') return 0;
  return taxas[formaPagamento] || 0;
}

// Receita líquida de um agendamento, descontando a taxa de maquineta por forma de pagamento
// (ver routes/financeiro.js). Em pagamento dividido (formasPagamento preenchido), cada perna
// desconta a SUA própria taxa antes de somar — ex: R$30 no crédito com taxa 3% + R$20 no Pix com
// taxa 1% dá um desconto efetivo diferente de aplicar uma taxa só sobre o total de R$50. A perna
// Pix num pagamento dividido já é sempre uma cobrança real confirmada no Mercado Pago (exigido no
// checkout, ver routes/agendamentos.js), então não precisa do mesmo filtro de pagamento_status.
function receitaLiquidaComTaxas(valorBase, formaPagamento, formasPagamento, pagamentoStatus, taxas) {
  if (formasPagamento && formasPagamento.length > 0) {
    return formasPagamento.reduce((acc, perna) => {
      const taxaPct = taxas[perna.forma_pagamento] || 0;
      return acc + Number(perna.valor || 0) * (1 - taxaPct / 100);
    }, 0);
  }
  const taxaPct = taxaParaForma(formaPagamento, pagamentoStatus, taxas);
  return Number(valorBase || 0) * (1 - taxaPct / 100);
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

  // Antes disso, planos abaixo do Enterprise recebiam 403 e não viam relatório NENHUM (nem
  // resumo, nem filtro de data, nem faturamento por dia — só um aviso de upsell). Agora todo
  // plano pago vê o essencial (resumo + faturamento por dia, com o mesmo filtro de data); só o
  // comparativo com o período anterior e os rankings (top serviços/profissionais/recorrência)
  // continuam exclusivos do Enterprise, sinalizado no campo `avancado` da resposta.
  const avancado = await permiteRelatoriosAvancados(empresaId);

  const hoje = formatarDataLocal(new Date());
  const dataInicio = req.query.dataInicio || hoje;
  const dataFim = req.query.dataFim || hoje;

  try {
    const { data: empresaRow } = await supabase.from('empresas').select('taxas_pagamento').eq('id', empresaId).maybeSingle();
    const taxas = { dinheiro: 0, credito: 0, debito: 0, pix: 0, ...(empresaRow?.taxas_pagamento || {}) };

    const { data: agendamentos, error } = await supabase
      .from('agendamentos')
      .select('id, status, data_hora, valor_total, usuario_id, barbeiro_id, forma_pagamento, formas_pagamento, pagamento_status, barbeiros(nome)')
      .eq('empresa_id', empresaId)
      .gte('data_hora', `${dataInicio}T00:00:00`)
      .lte('data_hora', `${dataFim}T23:59:59`);

    if (error) throw error;

    const concluidos = (agendamentos || []).filter((a) => a.status === 'concluido');
    const cancelados = (agendamentos || []).filter((a) => a.status === 'cancelado');
    const total = (agendamentos || []).length;

    const faturamentoTotal = concluidos.reduce((acc, a) => acc + Number(a.valor_total || 0), 0);
    // Receita líquida: desconta a taxa de maquineta cadastrada (ver routes/financeiro.js) pra
    // cada agendamento, de acordo com a(s) forma(s) de pagamento usada(s). Agendamentos sem
    // forma_pagamento registrada (histórico antigo, ou fechado sem informar) entram sem desconto.
    const receitaLiquidaTotal = concluidos.reduce((acc, a) => (
      acc + receitaLiquidaComTaxas(a.valor_total, a.forma_pagamento, a.formas_pagamento, a.pagamento_status, taxas)
    ), 0);
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
      avancado,
      periodo: { inicio: dataInicio, fim: dataFim },
      resumo: {
        faturamento_total: faturamentoTotal,
        receita_liquida: Number(receitaLiquidaTotal.toFixed(2)),
        ticket_medio: ticketMedio,
        quantidade_concluidos: concluidos.length,
        taxa_cancelamento: Number(taxaCancelamento.toFixed(1)),
        // Comparação com o período anterior é só do plano Enterprise (junto com os rankings
        // abaixo) — planos menores recebem null em vez do número, pro front não exibir a
        // variação sem também mostrar de onde ela vem.
        faturamento_periodo_anterior: avancado ? faturamentoAnterior : null,
        variacao_faturamento_pct: avancado ? Number(variacaoFaturamentoPct.toFixed(1)) : null
      },
      serie_diaria: serieDiaria,
      top_servicos: avancado ? topServicos : [],
      top_profissionais: avancado ? topProfissionais : [],
      recorrencia: avancado ? {
        total_clientes_periodo: clientesNoPeriodo.length,
        clientes_recorrentes: clientesRecorrentes,
        taxa_recorrencia_pct: Number(taxaRecorrenciaPct.toFixed(1))
      } : null
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
      .select('id, barbeiro_id, usuario_id, valor_total, forma_pagamento, formas_pagamento, pagamento_status, data_hora')
      .eq('empresa_id', empresaId)
      .eq('status', 'concluido')
      .gte('data_hora', `${dataInicio}T00:00:00`)
      .lte('data_hora', `${dataFim}T23:59:59`);
    if (error) throw error;

    // Rateio de cliente assinante: o atendimento em si custa R$0 (ou menos que o preço de
    // tabela) pro assinante, já descontado no checkout (ver calcularValorComLimiteAssinante), mas
    // ele PAGOU pela mensalidade — então, só pra fins de comissão, atribuímos ao profissional a
    // fatia proporcional do valor do plano (preço mensal ÷ quantidade de visitas cobertas naquele
    // CICLO de cobrança do cliente).
    //
    // Usamos `plano_id` (não o boolean `assinante`, que reflete só o status ATUAL) pra achar o
    // preço da mensalidade a ratear — senão, assim que o cliente cancela/deixa de pagar, TODO o
    // histórico de comissão dos cortes que ele fez enquanto era assinante silenciosamente vira
    // R$0 (o relatório é sobre o passado, o status de hoje não devia apagá-lo). Isso ainda não
    // cobre o caso em que o admin remove a assinatura manualmente (zera plano_id também, ver
    // routes/assinaturas.js) — sem uma tabela de histórico de assinatura, não dá pra recuperar
    // o preço vigente na época depois disso.
    const idsClientes = [...new Set(agendamentos.map((a) => a.usuario_id).filter(Boolean))];
    const precoAssinaturaPorCliente = {};
    const assinanteDesdePorCliente = {};
    const nomePorCliente = {};
    if (idsClientes.length > 0) {
      const { data: usuarios, error: erroUsuarios } = await supabase
        .from('usuarios')
        .select('id, nome_completo, plano_id, assinante_desde')
        .in('id', idsClientes);
      if (erroUsuarios) throw erroUsuarios;
      const planoIds = [...new Set((usuarios || []).filter((u) => u.plano_id).map((u) => u.plano_id))];
      let precoPorPlano = {};
      if (planoIds.length > 0) {
        const { data: planos } = await supabase.from('planos_assinatura').select('id, preco').in('id', planoIds);
        precoPorPlano = Object.fromEntries((planos || []).map((p) => [p.id, Number(p.preco) || 0]));
      }
      for (const u of usuarios || []) {
        nomePorCliente[u.id] = u.nome_completo;
        if (u.plano_id && precoPorPlano[u.plano_id] != null) {
          precoAssinaturaPorCliente[u.id] = precoPorPlano[u.plano_id];
          if (u.assinante_desde) assinanteDesdePorCliente[u.id] = u.assinante_desde;
        }
      }
    }

    // O ciclo de cobrança da assinatura é ancorado no dia em que o cliente assinou
    // (assinante_desde), não no mês-calendário — é o mesmo ciclo que o limite mensal por serviço
    // usa de verdade (ver calcularInicioCiclo em utils/limitesAssinatura.js). Quem assinou dia 10
    // tem cota nova todo dia 10, não no dia 1. Sem assinante_desde (cadastro antigo, anterior a
    // essa coluna existir) caímos de volta pro mês-calendário como aproximação.
    function cicloDoCliente(usuarioId, dataHoraIso) {
      const desde = assinanteDesdePorCliente[usuarioId];
      if (!desde) {
        // Sem assinante_desde: aproxima pelo mês-calendário da própria data (mesma regra de
        // sempre — cliente cadastrado antes dessa coluna existir).
        const [ano, mes] = dataHoraIso.slice(0, 7).split('-').map(Number);
        const inicio = `${dataHoraIso.slice(0, 7)}-01`;
        const proxAno = mes === 12 ? ano + 1 : ano;
        const proxMes = mes === 12 ? 1 : mes + 1;
        const fim = `${proxAno}-${String(proxMes).padStart(2, '0')}-01`;
        return { inicio, fim, chave: inicio };
      }
      const inicio = calcularInicioCiclo(desde, new Date(dataHoraIso));
      return { inicio, fim: calcularFimCiclo(inicio, desde), chave: inicio };
    }

    // Preço de tabela dos serviços de cada agendamento (id -> [{nome, valor}]) — usado tanto pra
    // deixar rastreável o que o profissional fez quanto (abaixo) pra detectar se aquele
    // atendimento específico foi coberto pela assinatura: comparamos com valor_total, que já sai
    // descontado no checkout quando o serviço está incluso no plano. Isso evita depender só do
    // cadastro do cliente — um assinante pode ter cortado fora do plano (serviço não incluso, ou
    // limite mensal excedido) e pago o valor cheio; esse corte não pode entrar no rateio.
    async function buscarServicosPorAgendamento(ids) {
      const mapa = {};
      if (ids.length === 0) return mapa;
      const { data: vinculos, error: erroVinculos } = await supabase
        .from('agendamento_servicos')
        .select('agendamento_id, servicos(nome, valor)')
        .in('agendamento_id', ids);
      if (erroVinculos) throw erroVinculos;
      for (const v of vinculos || []) {
        if (!v.servicos) continue;
        if (!mapa[v.agendamento_id]) mapa[v.agendamento_id] = [];
        mapa[v.agendamento_id].push({ nome: v.servicos.nome, valor: Number(v.servicos.valor || 0) });
      }
      return mapa;
    }

    const idsAgendamentos = agendamentos.map((a) => a.id);
    const servicosPorAgendamento = await buscarServicosPorAgendamento(idsAgendamentos);
    const valorCheioPorAgendamento = Object.fromEntries(
      Object.entries(servicosPorAgendamento).map(([id, servicos]) => [id, servicos.reduce((acc, s) => acc + s.valor, 0)])
    );
    const foiCobertoPorAssinatura = (a) => {
      if (!a.usuario_id || precoAssinaturaPorCliente[a.usuario_id] == null) return false;
      const valorCheio = valorCheioPorAgendamento[a.id];
      if (valorCheio == null) return false;
      return valorCheio > Number(a.valor_total || 0);
    };

    // A quantidade de visitas usada pra ratear a mensalidade tem que ser a do CICLO inteiro do
    // cliente, não só dos agendamentos que caíram dentro do filtro de data escolhido no
    // relatório — senão um filtro que não bate exato com o ciclo (ex.: "últimos 7 dias", ou um
    // ciclo que começa no meio do mês) faz o rateio contar menos visitas do que o cliente
    // realmente teve, inflando indevidamente a fatia de cada corte e estourando o valor total da
    // assinatura. E só contam as visitas com evidência real de cobertura (valor_total abaixo do
    // preço de tabela), não qualquer visita de alguém que tem plano cadastrado.
    const idsAssinantes = idsClientes.filter((id) => precoAssinaturaPorCliente[id] != null);
    const visitasPorClienteMes = {};
    if (idsAssinantes.length > 0) {
      let janelaInicio = null;
      let janelaFim = null; // exclusivo
      for (const usuarioId of idsAssinantes) {
        const referencias = agendamentos.filter((a) => a.usuario_id === usuarioId).map((a) => a.data_hora);
        for (const dataHora of referencias) {
          const ciclo = cicloDoCliente(usuarioId, dataHora);
          if (!janelaInicio || ciclo.inicio < janelaInicio) janelaInicio = ciclo.inicio;
          if (!janelaFim || ciclo.fim > janelaFim) janelaFim = ciclo.fim;
        }
      }

      const { data: agendamentosCiclo, error: erroCiclo } = await supabase
        .from('agendamentos')
        .select('id, usuario_id, valor_total, data_hora')
        .eq('empresa_id', empresaId)
        .eq('status', 'concluido')
        .in('usuario_id', idsAssinantes)
        .gte('data_hora', `${janelaInicio}T00:00:00`)
        .lt('data_hora', `${janelaFim}T00:00:00`);
      if (erroCiclo) throw erroCiclo;

      const idsFaltantes = (agendamentosCiclo || []).map((a) => a.id).filter((id) => !(id in servicosPorAgendamento));
      const servicosExtras = await buscarServicosPorAgendamento(idsFaltantes);
      for (const [id, servicos] of Object.entries(servicosExtras)) {
        servicosPorAgendamento[id] = servicos;
        valorCheioPorAgendamento[id] = servicos.reduce((acc, s) => acc + s.valor, 0);
      }

      for (const a of agendamentosCiclo || []) {
        if (!foiCobertoPorAssinatura(a)) continue;
        const ciclo = cicloDoCliente(a.usuario_id, a.data_hora);
        const chave = `${a.usuario_id}-${ciclo.chave}`;
        visitasPorClienteMes[chave] = (visitasPorClienteMes[chave] || 0) + 1;
      }
    }

    const porProfissional = {};
    for (const a of agendamentos) {
      if (!a.barbeiro_id) continue;

      const ehAssinante = foiCobertoPorAssinatura(a);
      let receita = Number(a.valor_total || 0);
      let visitas = 1;
      if (ehAssinante) {
        const ciclo = cicloDoCliente(a.usuario_id, a.data_hora);
        const chave = `${a.usuario_id}-${ciclo.chave}`;
        visitas = visitasPorClienteMes[chave] || 1;
        receita = precoAssinaturaPorCliente[a.usuario_id] / visitas;
      }

      // Pagamento dividido só se aplica à fatia avulsa (receita === valor_total) — a fatia
      // rateada de assinatura não corresponde a um pagamento real feito NESTE atendimento (foi a
      // mensalidade, cobrada em outro momento/forma), então usa a taxa única de sempre.
      const receitaLiquida = ehAssinante
        ? receita * (1 - taxaParaForma(a.forma_pagamento, a.pagamento_status, taxas) / 100)
        : receitaLiquidaComTaxas(a.valor_total, a.forma_pagamento, a.formas_pagamento, a.pagamento_status, taxas);
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
        servicos: (servicosPorAgendamento[a.id] || []).map((s) => s.nome),
        tipo: ehAssinante ? 'assinante' : 'avulso',
        visitas_no_mes: ehAssinante ? visitas : null,
        valor_base: Number(a.valor_total || 0),
        valor_atribuido: Number(receita.toFixed(2)),
        receita_liquida: Number(receitaLiquida.toFixed(2)),
        comissao: Number(comissao.toFixed(2)),
        formas_pagamento: a.formas_pagamento || null
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
