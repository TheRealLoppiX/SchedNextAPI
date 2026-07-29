const supabase = require('../config/supabase');

async function obterLimitesEmpresa(empresaId) {
  const { data } = await supabase
    .from('empresas')
    .select('plano_plataforma:plano_plataforma_id(limite_profissionais, limite_agendamentos_mes, permite_multi_unidade, permite_api_publica, permite_ia, permite_relatorios_avancados, permite_dominio_customizado)')
    .eq('id', empresaId)
    .maybeSingle();

  return data?.plano_plataforma || { limite_profissionais: null, limite_agendamentos_mes: null, permite_multi_unidade: false, permite_api_publica: false, permite_ia: false, permite_relatorios_avancados: false, permite_dominio_customizado: false };
}

// Multi-unidade e API pública são recursos do plano Enterprise (ver §3 do plano de plataforma).
async function permiteMultiUnidade(empresaId) {
  const { permite_multi_unidade } = await obterLimitesEmpresa(empresaId);
  return !!permite_multi_unidade;
}

async function permiteApiPublica(empresaId) {
  const { permite_api_publica } = await obterLimitesEmpresa(empresaId);
  return !!permite_api_publica;
}

// Relatórios avançados e domínio próprio também são exclusivos do plano Enterprise.
async function permiteRelatoriosAvancados(empresaId) {
  const { permite_relatorios_avancados } = await obterLimitesEmpresa(empresaId);
  return !!permite_relatorios_avancados;
}

async function permiteDominioCustomizado(empresaId) {
  const { permite_dominio_customizado } = await obterLimitesEmpresa(empresaId);
  return !!permite_dominio_customizado;
}

// Recursos de IA: planos acima de R$100/mês (Profissional/Enterprise, ver planos_plataforma).
async function permiteIA(empresaId) {
  const { permite_ia } = await obterLimitesEmpresa(empresaId);
  return !!permite_ia;
}

// null no limite = ilimitado (planos Profissional/Enterprise, ver planos_plataforma)
async function limiteProfissionaisAtingido(empresaId) {
  const { limite_profissionais } = await obterLimitesEmpresa(empresaId);
  if (limite_profissionais == null) return false;

  const { count } = await supabase
    .from('barbeiros')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresaId);

  return (count || 0) >= limite_profissionais;
}

async function limiteAgendamentosMesAtingido(empresaId) {
  const { limite_agendamentos_mes } = await obterLimitesEmpresa(empresaId);
  if (limite_agendamentos_mes == null) return false;

  const { count } = await supabase
    .from('agendamentos')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresaId)
    .gte('data_hora', `${inicioDoMesUTC()}T00:00:00`)
    .neq('status', 'cancelado');

  return (count || 0) >= limite_agendamentos_mes;
}

function inicioDoMesUTC() {
  const inicioMes = new Date();
  inicioMes.setUTCDate(1);
  return inicioMes.toISOString().slice(0, 10);
}

// --- Mitigação da corrida de "checar-depois-inserir" ---
//
// limiteAgendamentosMesAtingido/limiteProfissionaisAtingido acima são chamadas ANTES do
// insert em cada rota. Entre essa checagem e o insert de verdade existe uma janela onde
// duas requisições concorrentes podem passar as duas pela checagem antes de qualquer uma
// inserir, deixando a empresa acima do limite do plano. Eliminar essa janela por completo
// exigiria uma função Postgres (checagem + insert na mesma transação, com lock), o que está
// fora do alcance do cliente HTTP do Supabase usado aqui (cada chamada é sua própria
// transação). As duas funções abaixo são chamadas DEPOIS do insert, bem na sequência, e
// desfazem a inserção se a recontagem mostrar que o limite foi ultrapassado. Não é atômico
// de verdade, mas reduz a janela de exploração de "todo o tempo entre checar e inserir" pra
// "o tempo entre inserir e reconferir" (uma volta a mais ao banco, sem gap de rede/pensamento
// do cliente no meio).
async function confirmarLimiteAgendamentosOuDesfazer(empresaId, agendamentoId) {
  const { limite_agendamentos_mes } = await obterLimitesEmpresa(empresaId);
  if (limite_agendamentos_mes == null) return true;

  const { count } = await supabase
    .from('agendamentos')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresaId)
    .gte('data_hora', `${inicioDoMesUTC()}T00:00:00`)
    .neq('status', 'cancelado');

  if ((count || 0) > limite_agendamentos_mes) {
    await supabase.from('agendamentos').delete().eq('id', agendamentoId);
    return false;
  }
  return true;
}

async function confirmarLimiteProfissionaisOuDesfazer(empresaId, barbeiroId) {
  const { limite_profissionais } = await obterLimitesEmpresa(empresaId);
  if (limite_profissionais == null) return true;

  const { count } = await supabase.from('barbeiros').select('id', { count: 'exact', head: true }).eq('empresa_id', empresaId);

  if ((count || 0) > limite_profissionais) {
    await supabase.from('barbeiros').delete().eq('id', barbeiroId);
    return false;
  }
  return true;
}

module.exports = {
  limiteProfissionaisAtingido,
  limiteAgendamentosMesAtingido,
  confirmarLimiteAgendamentosOuDesfazer,
  confirmarLimiteProfissionaisOuDesfazer,
  permiteMultiUnidade,
  permiteApiPublica,
  permiteIA,
  permiteRelatoriosAvancados,
  permiteDominioCustomizado
};
