const bcrypt = require('bcrypt');

// Valida senha contra um hash bcrypt e, se o valor armazenado ainda estiver em texto puro
// (contas antigas), valida por igualdade uma última vez e aciona onMigrar com o novo hash,
// para que o próximo login já esteja em bcrypt. Evita manter um fallback de texto puro pra sempre.
async function validarSenhaComMigracao(hashArmazenado, senhaDigitada, onMigrar) {
  const valor = hashArmazenado || '';
  if (valor.startsWith('$2')) {
    return bcrypt.compare(senhaDigitada, valor);
  }
  if (senhaDigitada && senhaDigitada === valor) {
    const novoHash = await bcrypt.hash(senhaDigitada, 12);
    if (onMigrar) await onMigrar(novoHash);
    return true;
  }
  return false;
}

module.exports = validarSenhaComMigracao;
