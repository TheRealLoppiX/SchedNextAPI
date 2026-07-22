// O telefone chega em formatos diferentes dependendo da origem: cadastro pelo site salva
// com máscara e sem DDI ("(81) 98437-8852", ver frontend/src/utils/telefone.js), cadastro
// rápido pelo admin salva só dígitos sem DDI, e o WhatsApp (Meta Cloud API) manda o `wa_id`
// só em dígitos COM DDI e às vezes sem o 9º dígito (número brasileiro antigo, ver handoff.md,
// erro 131030 documentado). Comparar essas strings direto praticamente nunca bate. Esta
// função normaliza pra DDD+número (10 ou 11 dígitos, sem DDI) pra permitir comparação real.
function apenasDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

function normalizarTelefoneBR(v) {
  const digitos = apenasDigitos(v);
  // DDI 55 só é removido quando sobra um DDD+número plausível (10 ou 11 dígitos) depois.
  // Sem essa checagem, um número de fixo de 10 dígitos que por acaso começa com "55" (DDD 55 =
  // Rio Grande do Sul) seria cortado por engano.
  if (digitos.length > 11 && digitos.startsWith('55')) {
    return digitos.slice(2);
  }
  return digitos;
}

// Gera as variantes plausíveis (com/sem o 9º dígito) do mesmo número, já sem DDI.
function variantesTelefoneBR(v) {
  const base = normalizarTelefoneBR(v);
  if (base.length === 11) {
    return [base, base.slice(0, 2) + base.slice(3)];
  }
  if (base.length === 10) {
    return [base, base.slice(0, 2) + '9' + base.slice(2)];
  }
  return [base];
}

module.exports = { apenasDigitos, normalizarTelefoneBR, variantesTelefoneBR };
