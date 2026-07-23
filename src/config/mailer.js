const nodemailer = require('nodemailer');

// Voltamos para o Gmail via SMTP: sem domínio próprio, um serviço terceiro (Brevo) nunca
// consegue autenticar de verdade um remetente @gmail.com (SPF/DKIM só o Google controla),
// então o e-mail saía rejeitado ou era marcado como suspeito pelo próprio Gmail do destinatário.
// Enviando direto pela infraestrutura do Google (com senha de app), o remetente é genuíno.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  // No Render, smtp.gmail.com às vezes resolve pra um endereço IPv6 que o container não
  // consegue rotear (ENETUNREACH), enquanto IPv4 sempre funciona. Forçar a família evita
  // depender de qual endereço o DNS devolve primeiro.
  family: 4,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

module.exports = transporter;
