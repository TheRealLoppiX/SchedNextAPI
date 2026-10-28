const net = require('net');

// IP real de quem fez a requisição, pra rate limit e antifraude.
//
// A API é acessada direto em schednextapi.onrender.com, que fica atrás do Cloudflare DO RENDER
// (não de uma zona nossa). Nesse caminho o req.ip (derivado do X-Forwarded-For com trust proxy)
// muitas vezes sai como o IP de uma borda do Cloudflare, que muda a cada requisição: medido em
// produção em 28/10, o contador do rate limit reiniciava a cada tentativa, ou seja, o limite de
// login/cadastro/código não segurava ninguém. O Cloudflare sempre preenche cf-connecting-ip com o
// IP do cliente e sobrescreve qualquer valor mandado pelo próprio cliente, então ele é a fonte
// confiável — mas só quando a API está mesmo atrás do Cloudflare. Fora do Render (ex: dev local)
// o header seria forjável, por isso só é usado com RENDER=true (variável que o próprio Render
// define) ou CONFIAR_CF_CONNECTING_IP=true.
const confiarCloudflare = () => process.env.RENDER === 'true' || process.env.CONFIAR_CF_CONNECTING_IP === 'true';

function ipDoCliente(req) {
  if (confiarCloudflare()) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (net.isIP(cf)) return cf;
  }
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

module.exports = { ipDoCliente };
