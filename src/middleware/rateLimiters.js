const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' }
});

const cadastroEmpresaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de cadastro. Tente novamente em algumas horas.' }
});

const apiPublicaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde um minuto e tente novamente.' }
});

// Protege os fluxos de código de 6 dígitos (confirmação de cadastro, recuperação de senha,
// alteração de dados sensíveis). Antes disso não havia nenhum limite, então o código era
// brute-forceável (10^6 combinações) sem bloqueio.
const codigoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' }
});

module.exports = { loginLimiter, cadastroEmpresaLimiter, apiPublicaLimiter, codigoLimiter };
