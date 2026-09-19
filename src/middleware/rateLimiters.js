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

// POST /registrar (cliente final) não tinha nenhum limite — dava pra inundar
// cadastros_pendentes e o crédito de e-mail da Brevo com tentativas sem fim.
const cadastroClienteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
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

// Defesa em profundidade pro webhook do WhatsApp (ver routes/whatsapp.js): a validação do
// ?secret já barra quem não conhece o segredo, mas isso continua sendo o único endpoint público
// da API sem JWT nem chave de API — um limite generoso por IP evita que a instância da Evolution
// (ou um segredo eventualmente vazado) consiga martelar o servidor sem controle nenhum. O teto é
// alto de propósito: uma única VPS Evolution encaminha a conversa em tempo real de TODAS as
// empresas conectadas na plataforma, então o tráfego legítimo já é naturalmente mais alto que os
// outros limitadores acima.
const whatsappWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições.' }
});

module.exports = { loginLimiter, cadastroEmpresaLimiter, cadastroClienteLimiter, apiPublicaLimiter, codigoLimiter, whatsappWebhookLimiter };
