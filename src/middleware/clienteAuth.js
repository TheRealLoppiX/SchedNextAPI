const jwt = require('jsonwebtoken');

// Protege as rotas de perfil do cliente (routes/perfil.js), que até aqui não exigiam
// nenhum token: qualquer um podia ler/editar/cancelar dados de qualquer usuário só
// incrementando um ID na URL. O token aqui é o mesmo emitido em /login ({ id }).
function verificarTokenCliente(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de acesso não fornecido.' });
  }

  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.id) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }
    req.usuarioId = String(payload.id);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = verificarTokenCliente;
