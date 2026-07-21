const supabase = require('../config/supabase');

async function obterLimitesEmpresa(empresaId) {
  const { data } = await supabase
    .from('empresas')
    .select('plano_plataforma:plano_plataforma_id(limite_profissionais, limite_agendamentos_mes, permite_multi_unidade, permite_api_publica, permite_ia)')
    .eq('id', empresaId)
    .maybeSingle();

  return data?.plano_plataforma || { limite_profissionais: null, limite_agendamentos_mes: null, permite_multi_unidade: false, permite_api_publica: false, permite_ia: false };
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

// Recursos de IA — planos acima de R$100/mês (Profissional/Enterprise, ver planos_plataforma).
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

  const inicioMes = new Date();
  inicioMes.setUTCDate(1);
  const inicioMesStr = inicioMes.toISOString().slice(0, 10);

  const { count } = await supabase
    .from('agendamentos')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', empresaId)
    .gte('data_hora', `${inicioMesStr}T00:00:00`)
    .neq('status', 'cancelado');

  return (count || 0) >= limite_agendamentos_mes;
}

module.exports = { limiteProfissionaisAtingido, limiteAgendamentosMesAtingido, permiteMultiUnidade, permiteApiPublica, permiteIA };
