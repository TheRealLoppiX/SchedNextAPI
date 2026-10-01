// Vencimento das mensalidades de cliente final configurável pela empresa (empresas.
// assinatura_modo_vencimento / assinatura_dias_vencimento / assinatura_primeira_cobranca, ver
// sql/2026_assinatura_dias_semana_vencimento.sql).
//
// O ciclo inteiro (cobrança no cron, cota mensal de serviços) já é ancorado em
// usuarios.assinante_desde (ver utils/limitesAssinatura.js), então "vencer todo dia 5" é só
// ancorar assinante_desde num dia 5. O que muda é a primeira cobrança de quem assina entre os
// vencimentos, decidida pela regra da empresa:
//   proporcional      paga agora só os dias até o vencimento (ajuste, não conta como ciclo);
//   cheia_ciclo_longo paga cheio agora e o 1º ciclo vai até o dia fixo depois de 1 mês;
//   no_dia_fixo       não paga agora, o plano já vale e a 1ª cobrança é no dia fixo.
// No cartão a regra não se aplica: o Mercado Pago só começa a cobrar numa data e repete todo mês
// (preapproval sem plano não tem proporcional), então a 1ª cobrança é sempre no dia fixo.

const DIA_MS = 24 * 60 * 60 * 1000;
// Mesma base do proporcional do Mercado Pago (mês de 30 dias).
const DIAS_BASE_PROPORCIONAL = 30;

const paraData = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
const paraIso = (data) => data.toISOString().slice(0, 10);
const diasEntre = (deIso, ateIso) => Math.round((paraData(ateIso) - paraData(deIso)) / DIA_MS);

// Hoje no fuso de Brasília (AAAA-MM-DD).
function hojeBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Primeira data >= referência que cai no dia do mês informado (1 a 28, então todo mês tem).
function proximaDataComDia(referenciaIso, dia) {
  const ref = paraData(referenciaIso);
  const candidata = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), dia));
  if (candidata < ref) candidata.setUTCMonth(candidata.getUTCMonth() + 1);
  return paraIso(candidata);
}

// Primeira data >= referência que cai em qualquer um dos dias.
function proximaDataComAlgumDia(referenciaIso, dias) {
  return dias.map((d) => proximaDataComDia(referenciaIso, d)).sort()[0];
}

function somarUmMes(iso) {
  const d = paraData(iso);
  const dia = d.getUTCDate();
  const alvo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dia, ultimo));
  return paraIso(alvo);
}

function valorProporcional(valorCheio, dias) {
  const valor = Math.round((Number(valorCheio) * dias / DIAS_BASE_PROPORCIONAL) * 100) / 100;
  return Math.min(Number(valorCheio), Math.max(valor, 0.01));
}

// Plano de quem está ativando a cobrança agora no modo de dias fixos. Devolve a nova âncora
// (assinante_desde) e a cobrança a fazer agora (null = nenhuma; o plano já vale).
function planejarNovaAssinatura({ hoje = hojeBrasilia(), dia, regra, formaPagamento, valorCiclo }) {
  const proximoVencimento = proximaDataComDia(hoje, dia);

  // Assinou no próprio dia do vencimento: igual ao modo normal.
  if (proximoVencimento === hoje) {
    return { assinanteDesde: hoje, cobrancaAgora: { valor: Number(valorCiclo), ajuste: false } };
  }

  if (formaPagamento === 'cartao' || regra === 'no_dia_fixo') {
    return { assinanteDesde: proximoVencimento, cobrancaAgora: null };
  }

  if (regra === 'cheia_ciclo_longo') {
    return {
      assinanteDesde: proximaDataComDia(somarUmMes(hoje), dia),
      cobrancaAgora: { valor: Number(valorCiclo), ajuste: false }
    };
  }

  // proporcional
  return {
    assinanteDesde: proximoVencimento,
    cobrancaAgora: { valor: valorProporcional(valorCiclo, diasEntre(hoje, proximoVencimento)), ajuste: true }
  };
}

// Migração de quem já assina: aplicada no dia da próxima cobrança dele (dataTransicao). Devolve a
// nova âncora e a cobrança de transição desse dia (null = nenhuma). Mesma lógica da assinatura
// nova, com a transição no lugar do "hoje".
function planejarTransicao({ dataTransicao, dias, regra, formaPagamento, valorCiclo }) {
  const novoVencimento = proximaDataComAlgumDia(dataTransicao, dias);
  const dia = paraData(novoVencimento).getUTCDate();
  return planejarNovaAssinatura({ hoje: dataTransicao, dia, regra, formaPagamento, valorCiclo });
}

module.exports = {
  hojeBrasilia,
  proximaDataComDia,
  proximaDataComAlgumDia,
  somarUmMes,
  valorProporcional,
  planejarNovaAssinatura,
  planejarTransicao
};
