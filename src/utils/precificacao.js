// Lógica de "preço do N-ésimo ciclo" compartilhada entre services/precificacaoAssinatura.js
// (planos de assinatura do cliente final) e services/precificacaoPlataforma.js (assinatura da
// própria empresa na SchedNext) — as duas tinham a mesma função precoDoCiclo() copiada byte a
// byte, cada uma lendo uma coluna diferente da campanha. Extraído aqui pra não ter duas cópias
// pra manter sincronizadas (um fix de arredondamento numa não valeria pra outra).
function resolverPrecoDoCiclo(precosCiclo, numeroCiclo, precoPadrao) {
  if (!precosCiclo) return Number(precoPadrao);
  const linha = precosCiclo.find((p) => p.numero_ciclo === numeroCiclo);
  return linha ? Number(linha.valor) : Number(precoPadrao);
}

module.exports = { resolverPrecoDoCiclo };
