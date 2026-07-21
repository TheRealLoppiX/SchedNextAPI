const nodemailer = require('nodemailer');

// Voltamos para o Gmail via SMTP: sem domínio próprio, um serviço terceiro (Brevo) nunca
// consegue autenticar de verdade um remetente @gmail.com (SPF/DKIM só o Google controla),
// então o e-mail saía rejeitado ou era marcado como suspeito pelo próprio Gmail do destinatário.
// Enviando direto pela infraestrutura do Google (com senha de app), o remetente é genuíno.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

module.exports = transporter;
