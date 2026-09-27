const crypto = require('crypto');
const supabase = require('../config/supabase');
const { montarUrlTenant } = require('../utils/tenantContext');

const VALIDADE_MINUTOS = 15;

// Gera um link pro site do negócio que, se aberto, já deixa o cliente logado na própria conta —
// usado pelo bot de WhatsApp quando já sabe quem é o cliente (telefone reconhecido em
// encontrarClientePorTelefone), pra ele não precisar digitar e-mail/senha de novo só pra ver o
// que já resolveu pelo WhatsApp. Sem usuarioId (cliente ainda não identificado/cadastrado), cai
// pro link comum da loja, que pede login normal.
//
// Código curto (8 caracteres) em vez de JWT: um token assinado ficava com 150+ caracteres, ruim
// de mandar por WhatsApp. O código NUNCA é usado direto como sessão — é só uma chave de troca de
// uso único (apagada assim que consumida, ver POST /login-magico em routes/auth.js), guardada em
// login_magico_codigos com validade curta. Falha ao gravar cai pro link comum, sem quebrar o
// fluxo do bot.
async function gerarLinkAcesso(empresaTenant, usuarioId) {
  if (!empresaTenant) return null;
  if (!usuarioId) return montarUrlTenant(empresaTenant);

  const codigo = crypto.randomBytes(6).toString('base64url'); // 8 caracteres, ~48 bits
  const expiraEm = new Date(Date.now() + VALIDADE_MINUTOS * 60000).toISOString();
  const { error } = await supabase.from('login_magico_codigos').insert({ codigo, usuario_id: usuarioId, expira_em: expiraEm });
  if (error) {
    console.error('Erro ao gerar código de login mágico:', error);
    return montarUrlTenant(empresaTenant);
  }

  return montarUrlTenant(empresaTenant, `/entrar-magico?token=${codigo}`);
}

module.exports = { gerarLinkAcesso };
