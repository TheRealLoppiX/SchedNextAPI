const jwt = require('jsonwebtoken');

// Protege toda a área /admin/*. O único endpoint sob /admin que fica de fora é o próprio
// /admin/login (é ele quem emite o token). Todo o resto, incluindo /admin/estoque/*, só é
// alcançado depois que o dono da empresa já fez login, então exigir esse mesmo token aqui
// também é o comportamento correto (o sub-login de colaborador de estoque continua existindo
// como uma segunda checagem por cima desta).
function verificarTokenAdmin(req, res, next) {
  if (req.originalUrl === '/admin/login' || req.originalUrl.startsWith('/admin/login?')) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de acesso não fornecido.' });
  }

  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.tipo !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }
    req.empresaId = payload.empresa_id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = verificarTokenAdmin;
