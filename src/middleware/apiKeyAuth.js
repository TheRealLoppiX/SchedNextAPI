const crypto = require('crypto');
const supabase = require('../config/supabase');

// Autenticação da API pública (recurso Enterprise, ver §11 do plano de plataforma). É
// deliberadamente separada do JWT usado em /admin/*: quem chama essa API é um sistema
// externo integrando com a conta do cliente, não o próprio dono logado no painel.
// Chaves são hasheadas com SHA-256 (não bcrypt): são tokens de alta entropia gerados por
// nós, não senhas escolhidas por humano, então não faz sentido usar hash lento. O objetivo
// aqui é permitir a busca direta pelo hash, algo que bcrypt não permite.
function hashChave(chave) {
  return crypto.createHash('sha256').update(chave).digest('hex');
}

async function autenticarApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chave de API não fornecida.' });
  }

  const chave = authHeader.slice('Bearer '.length).trim();
  const hash = hashChave(chave);

  const { data: apiKey } = await supabase
    .from('api_keys')
    .select('id, empresa_id, ativo, empresas!inner(plano_plataforma:plano_plataforma_id(permite_api_publica))')
    .eq('key_hash', hash)
    .maybeSingle();

  if (!apiKey || !apiKey.ativo) {
    return res.status(401).json({ error: 'Chave de API inválida ou revogada.' });
  }

  if (!apiKey.empresas?.plano_plataforma?.permite_api_publica) {
    return res.status(403).json({ error: 'API pública não está disponível no plano atual desta conta.' });
  }

  req.empresaId = apiKey.empresa_id;
  supabase.from('api_keys').update({ ultimo_uso_em: new Date().toISOString() }).eq('id', apiKey.id).then(() => {});

  next();
}

module.exports = { autenticarApiKey, hashChave };
