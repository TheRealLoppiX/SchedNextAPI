// O Render bloqueia saída SMTP nas portas 465 e 587 (confirmado: conexão trava até
// ETIMEDOUT em ambas, mesmo forçando IPv4), então SMTP direto pro Gmail nunca funciona
// em produção — não é bug de configuração, é a rede do provedor. A saída é enviar por
// API HTTP (porta 443, nunca bloqueada). Usamos a API do Brevo com um remetente
// verificado em schednext.com.br (domínio já autenticado lá, com SPF/DKIM corretos) —
// diferente da tentativa anterior com Brevo, que tentava forjar um remetente @gmail.com
// e caía em spam por falha de SPF/DKIM (só o Google pode autenticar esse domínio).
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL;
const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'SchedNext';

async function enviarViaBrevo(mailOptions) {
  const corpo = {
    sender: { email: SENDER_EMAIL, name: SENDER_NAME },
    to: [{ email: mailOptions.to }],
    subject: mailOptions.subject
  };
  if (mailOptions.html) corpo.htmlContent = mailOptions.html;
  else corpo.textContent = mailOptions.text;

  const resposta = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(corpo)
  });

  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    throw new Error(`Brevo respondeu ${resposta.status}: ${detalhe}`);
  }
  return resposta.json();
}

// Mantém a mesma interface do nodemailer (transporter.sendMail), nos dois estilos de
// chamada já usados no código: com callback (err) => {} e sem callback (retorna Promise,
// pra usar com await ou .catch()) — assim nenhuma rota que já usa o mailer precisa mudar.
function sendMail(mailOptions, callback) {
  const promessa = enviarViaBrevo(mailOptions);
  if (typeof callback === 'function') {
    promessa.then((info) => callback(null, info)).catch((err) => callback(err));
    return;
  }
  return promessa;
}

module.exports = { sendMail };
