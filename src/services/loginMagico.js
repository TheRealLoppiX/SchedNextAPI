const jwt = require('jsonwebtoken');
const { montarUrlTenant } = require('../utils/tenantContext');

const VALIDADE_MINUTOS = 15;

// Gera um link pro site do negócio que, se aberto, já deixa o cliente logado na própria conta —
// usado pelo bot de WhatsApp quando já sabe quem é o cliente (telefone reconhecido em
// encontrarClientePorTelefone), pra ele não precisar digitar e-mail/senha de novo só pra ver o
// que já resolveu pelo WhatsApp. Sem usuarioId (cliente ainda não identificado/cadastrado), cai
// pro link comum da loja, que pede login normal.
//
// O token aqui NUNCA é usado direto como sessão: é só uma chave de troca de curta duração
// (tipo:'login_magico' o distingue de um token de sessão de verdade, ver clienteAuth.js), trocada
// por uma sessão real só na primeira vez que for consumida em POST /login-magico (routes/auth.js).
// Assinado com o mesmo JWT_SECRET dos outros tokens do projeto — não precisa de tabela nem de
// limpeza própria, a validade curta já limita a janela de exposição se o link vazar.
function gerarLinkAcesso(empresaTenant, usuarioId) {
  if (!empresaTenant) return null;
  if (!usuarioId) return montarUrlTenant(empresaTenant);

  const token = jwt.sign({ id: usuarioId, tipo: 'login_magico' }, process.env.JWT_SECRET, { expiresIn: `${VALIDADE_MINUTOS}m` });
  return montarUrlTenant(empresaTenant, `/entrar-magico?token=${token}`);
}

module.exports = { gerarLinkAcesso };
