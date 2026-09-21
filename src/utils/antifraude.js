const { normalizarTelefoneBR, apenasDigitos } = require('./telefone');

// Normalizadores usados pelo antifraude de cadastro de empresa (ver services/antifraude.js).
// O objetivo é que variações triviais do MESMO dado caiam na mesma string: fulano+2@gmail.com,
// f.u.l.a.n.o@gmail.com e fulano@gmail.com são a mesma caixa postal no Gmail.

function normalizarEmail(email) {
  const [local, dominioBruto] = String(email || '').trim().toLowerCase().split('@');
  if (!local || !dominioBruto) return String(email || '').trim().toLowerCase();

  const dominio = dominioBruto === 'googlemail.com' ? 'gmail.com' : dominioBruto;
  let usuario = local.split('+')[0];
  if (dominio === 'gmail.com') usuario = usuario.replace(/\./g, '');
  return `${usuario}@${dominio}`;
}

function normalizarNomeEmpresa(nome) {
  return String(nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Telefone celular BR sem DDI; ignora a diferença do 9º dígito comparando DDD + 8 últimos.
function normalizarTelefone(v) {
  const base = normalizarTelefoneBR(v);
  if (base.length < 10) return base || null;
  return base.slice(0, 2) + base.slice(-8);
}

function cpfValido(d) {
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(d[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(d[t])) return false;
  }
  return true;
}

function cnpjValido(d) {
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  for (const t of [12, 13]) {
    const pesos = t === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((acc, p, i) => acc + Number(d[i]) * p, 0);
    const dv = soma % 11 < 2 ? 0 : 11 - (soma % 11);
    if (dv !== Number(d[t])) return false;
  }
  return true;
}

// Devolve só os dígitos se for um CPF ou CNPJ válido (dígitos verificadores), senão null.
function normalizarDocumento(v) {
  const d = apenasDigitos(v);
  if (cpfValido(d) || cnpjValido(d)) return d;
  return null;
}

module.exports = { normalizarEmail, normalizarNomeEmpresa, normalizarTelefone, normalizarDocumento };
