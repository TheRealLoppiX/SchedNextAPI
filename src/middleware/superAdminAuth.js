const jwt = require('jsonwebtoken');

// Protege toda a área /super-admin/*. Totalmente separado do admin de empresa
// (src/middleware/adminAuth.js): não carrega empresa_id nenhum, são contas de dono(s) da
// plataforma guardadas na tabela `super_admins` (ver routes/superAdmin.js). O token exige
// tipo === 'super_admin', então um token de admin de empresa (tipo === 'admin') nunca passa
// aqui, e vice-versa.
function verificarTokenSuperAdmin(req, res, next) {
  if (req.originalUrl === '/super-admin/login' || req.originalUrl.startsWith('/super-admin/login?')) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de acesso não fornecido.' });
  }

  const token = authHeader.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.tipo !== 'super_admin') {
      return res.status(403).json({ error: 'Acesso negado.' });
    }
    req.superAdmin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = verificarTokenSuperAdmin;
