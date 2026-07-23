const nodemailer = require('nodemailer');
const dns = require('dns');
const net = require('net');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;

// O resolver de DNS interno do nodemailer 9.x (lib/shared/index.js) busca A e AAAA e
// sorteia um endereço aleatório entre os dois, ignorando a opção `family` — não dá pra
// forçar IPv4 pela config normal. No Render isso alterna entre cair num IPv6 sem rota
// (ENETUNREACH) e num IPv4 cuja porta é bloqueada de forma diferente por tentativa. Pra
// contornar, resolvemos o IPv4 nós mesmos e entregamos a conexão já aberta via `getSocket`
// (hook do nodemailer pensado originalmente pra sockets de proxy), pulando o resolver dele.
function getSocket(options, callback) {
  dns.lookup(SMTP_HOST, { family: 4 }, (err, address) => {
    if (err) return callback(err);

    const socket = net.connect({ host: address, port: SMTP_PORT });
    const onError = (connErr) => {
      socket.destroy();
      callback(connErr);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      callback(null, { connection: socket });
    });
  });
}

// Voltamos para o Gmail via SMTP: sem domínio próprio, um serviço terceiro (Brevo) nunca
// consegue autenticar de verdade um remetente @gmail.com (SPF/DKIM só o Google controla),
// então o e-mail saía rejeitado ou era marcado como suspeito pelo próprio Gmail do destinatário.
// Enviando direto pela infraestrutura do Google (com senha de app), o remetente é genuíno.
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  getSocket,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

module.exports = transporter;
