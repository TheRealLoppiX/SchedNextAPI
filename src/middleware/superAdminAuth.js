const jwt = require('jsonwebtoken');

// Protege toda a área /super-admin/*. Totalmente separado do admin de empresa
// (src/middleware/adminAuth.js): não carrega empresa_id nenhum, é uma conta única do dono da
// plataforma (credenciais em SUPER_ADMIN_EMAIL/SUPER_ADMIN_SENHA_HASH no .env, não numa
// tabela — só existe uma). O token exige tipo === 'super_admin', então um token de admin de
// empresa (tipo === 'admin') nunca passa aqui, e vice-versa.
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
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = verificarTokenSuperAdmin;
