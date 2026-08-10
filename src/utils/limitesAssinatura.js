const supabase = require('../config/supabase');

// Ciclo rolante ancorado no dia-do-mes em que o cliente virou assinante (assinante_desde),
// tipo cobranca recorrente: quem assinou dia 10 reseta todo dia 10, nao no dia 1 do mes.
// Trabalha em UTC pra ficar consistente com o resto do arquivo de agendamentos (ver
// comentario em cancelar-agendamento sobre evitar conversao de fuso em cima de datas puras).
function calcularInicioCiclo(assinanteDesde, referencia = new Date()) {
  const inicio = new Date(`${String(assinanteDesde).slice(0, 10)}T00:00:00Z`);
  const ref = new Date(Date.UTC(referencia.getUTCFullYear(), referencia.getUTCMonth(), referencia.getUTCDate()));

  const diaAncora = inicio.getUTCDate();

  let cicloAno = ref.getUTCFullYear();
  let cicloMes = ref.getUTCMonth();
  let cicloInicio = diaClampado(cicloAno, cicloMes, diaAncora);

  if (cicloInicio > ref) {
    cicloMes -= 1;
    if (cicloMes < 0) { cicloMes = 11; cicloAno -= 1; }
    cicloInicio = diaClampado(cicloAno, cicloMes, diaAncora);
  }

  return cicloInicio < inicio ? inicio.toISOString().slice(0, 10) : cicloInicio.toISOString().slice(0, 10);
}

// Clampa pro ultimo dia do mes quando o mes de referencia e mais curto que o dia-ancora
// (ex.: assinou dia 31 -> em fevereiro o ciclo comeca no dia 28/29).
function diaClampado(ano, mes, dia) {
  const ultimoDiaDoMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ano, mes, Math.min(dia, ultimoDiaDoMes)));
}

// Início do próximo ciclo, mesmo dia-ancora do atual (com o mesmo clamp de mês curto). Usado
// pra delimitar a janela de "agendamentos pendentes deste ciclo" (ver obterAgendamentosPendentesPorServico).
function calcularFimCiclo(cicloInicio, assinanteDesde) {
  const inicio = new Date(`${cicloInicio}T00:00:00Z`);
  const diaAncora = new Date(`${String(assinanteDesde).slice(0, 10)}T00:00:00Z`).getUTCDate();
  let ano = inicio.getUTCFullYear();
  let mes = inicio.getUTCMonth() + 1;
  if (mes > 11) { mes = 0; ano += 1; }
  return diaClampado(ano, mes, diaAncora).toISOString().slice(0, 10);
}

// Conta, por serviço, quantos agendamentos AINDA NÃO finalizados (pendente/confirmado) o
// cliente já tem marcados dentro do ciclo atual. Diferente de obterUsoServicos (que só reflete
// consumo já debitado no fechamento de caixa), isso avisa o cliente ANTES de finalizar que a
// cota já está comprometida por agendamentos futuros ainda não atendidos.
async function obterAgendamentosPendentesPorServico(usuarioId, servicoIds, cicloInicio, cicloFim) {
  if (!servicoIds || servicoIds.length === 0) return {};

  const { data: agendamentos, error } = await supabase
    .from('agendamentos')
    .select('id')
    .eq('usuario_id', usuarioId)
    .in('status', ['pendente', 'confirmado'])
    .gte('data_hora', `${cicloInicio}T00:00:00`)
    .lt('data_hora', `${cicloFim}T00:00:00`);

  if (error) { console.error('Erro obterAgendamentosPendentesPorServico:', error); return {}; }
  if (!agendamentos || agendamentos.length === 0) return {};

  const { data: vinculos, error: errV } = await supabase
    .from('agendamento_servicos')
    .select('agendamento_id, servico_id')
    .in('agendamento_id', agendamentos.map((a) => a.id))
    .in('servico_id', servicoIds);

  if (errV) { console.error('Erro obterAgendamentosPendentesPorServico:', errV); return {}; }

  return (vinculos || []).reduce((acc, v) => {
    acc[v.servico_id] = (acc[v.servico_id] || 0) + 1;
    return acc;
  }, {});
}

async function obterUsoServicos(usuarioId, servicoIds, cicloRef) {
  if (!servicoIds || servicoIds.length === 0) return {};

  const { data, error } = await supabase
    .from('assinatura_uso_mensal')
    .select('servico_id, usados')
    .eq('usuario_id', usuarioId)
    .eq('ciclo_ref', cicloRef)
    .in('servico_id', servicoIds);

  if (error) { console.error('Erro obterUsoServicos:', error); return {}; }

  return Object.fromEntries((data || []).map((r) => [r.servico_id, r.usados]));
}

// Checa e debita a cota atomicamente via RPC (ver sql/2026_limite_assinatura_corrida.sql).
// Precisa ser atômico porque ler "usados" e só depois escrever de volta (em passos separados)
// deixa uma janela: dois fechamentos de caixa do mesmo cliente/serviço/ciclo em sequência
// rápida podiam ler o mesmo valor antes de qualquer um escrever, e os dois liberavam como
// "dentro do limite" ao mesmo tempo — cliente com limite de 1 corte conseguindo 2 de graça.
// Retorna true se estava dentro do limite (e já debitou), false se estourou.
async function registrarUsoServico(usuarioId, servicoId, cicloRef, limite) {
  const { data, error } = await supabase.rpc('consumir_cota_assinatura', {
    p_usuario_id: usuarioId,
    p_servico_id: servicoId,
    p_ciclo_ref: cicloRef,
    p_limite: limite
  });

  if (error) {
    console.error('Erro registrarUsoServico:', error);
    // Sem conseguir confirmar a cota, cobra por segurança em vez de liberar de graça.
    return false;
  }

  return !!data;
}

// Substitui calcularValorComDescontoAssinante() (utils/valorAssinante.js) no checkout: além de
// checar se o serviço está incluso no plano, respeita o limite mensal por serviço (null =
// ilimitado) e, quando registrarConsumo=true, debita a cota no ciclo atual do cliente. Os
// outros chamadores de calcularValorComDescontoAssinante (/agendar, /admin/agendar-encaixe) só
// mostram uma estimativa no momento de agendar — a cobrança de verdade sempre passa pelo
// checkout, que é o único lugar que precisa (e deve) saber sobre limite/consumo.
async function calcularValorComLimiteAssinante(usuarioId, servicos, { registrarConsumo = false } = {}) {
  const valorCheio = servicos.reduce((acc, s) => acc + Number(s.valor || 0), 0);
  const resultado = { valorBase: valorCheio, servicosCobertos: [], servicosCobrados: servicos.map((s) => s.id) };
  if (!usuarioId) return resultado;

  const { data: usuario } = await supabase
    .from('usuarios')
    .select('assinante, plano_id, assinante_desde')
    .eq('id', usuarioId)
    .maybeSingle();

  if (!usuario?.assinante || !usuario.plano_id) return resultado;

  const idsServicos = servicos.map((s) => s.id);
  const { data: psRows } = await supabase
    .from('plano_servicos')
    .select('servico_id, limite_mensal')
    .eq('plano_id', usuario.plano_id)
    .in('servico_id', idsServicos);

  const limitePorServico = Object.fromEntries((psRows || []).map((r) => [r.servico_id, r.limite_mensal]));
  const idsNoPlano = Object.keys(limitePorServico).map(Number);
  if (idsNoPlano.length === 0) return resultado;

  const idsLimitados = idsNoPlano.filter((id) => limitePorServico[id] != null);
  const cicloRef = usuario.assinante_desde ? calcularInicioCiclo(usuario.assinante_desde) : null;
  const uso = cicloRef ? await obterUsoServicos(usuarioId, idsLimitados, cicloRef) : {};
  const usadosNesteCheckout = {};

  let valorBase = valorCheio;
  const servicosCobertos = [];
  const servicosCobrados = [];

  for (const s of servicos) {
    if (!idsNoPlano.includes(s.id)) { servicosCobrados.push(s.id); continue; }

    const limite = limitePorServico[s.id];
    let dentroDoLimite;

    if (limite == null) {
      dentroDoLimite = true;
    } else if (registrarConsumo && cicloRef) {
      // Fechamento de caixa de verdade: decide e debita atomicamente no banco, não a partir da
      // leitura feita acima (que pode estar desatualizada por corrida com outro checkout).
      dentroDoLimite = await registrarUsoServico(usuarioId, s.id, cicloRef, limite);
    } else {
      // Só estimativa (agendar, preview) — não debita nada, então a leitura já feita basta.
      const jaUsados = (uso[s.id] || 0) + (usadosNesteCheckout[s.id] || 0);
      dentroDoLimite = jaUsados < limite;
    }

    if (dentroDoLimite) {
      valorBase -= Number(s.valor || 0);
      servicosCobertos.push(s.id);
      usadosNesteCheckout[s.id] = (usadosNesteCheckout[s.id] || 0) + 1;
    } else {
      servicosCobrados.push(s.id);
    }
  }

  return { valorBase: Math.max(0, valorBase), servicosCobertos, servicosCobrados };
}

module.exports = {
  calcularInicioCiclo,
  calcularFimCiclo,
  obterUsoServicos,
  obterAgendamentosPendentesPorServico,
  registrarUsoServico,
  calcularValorComLimiteAssinante
};
