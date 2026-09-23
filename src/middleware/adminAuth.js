const jwt = require('jsonwebtoken');

// Protege toda a área /admin/*. Ficam de fora só os endpoints que precisam ser alcançados por
// quem AINDA não tem token: o próprio /admin/login (é ele quem emite o token) e o fluxo de
// recuperação de senha (/admin/recuperar-senha, /admin/resetar-senha — ver routes/auth.js), já
// que quem esqueceu a senha por definição não consegue logar pra conseguir um token. Todo o
// resto, incluindo /admin/estoque/*, só é alcançado depois que o dono da empresa já fez login,
// então exigir esse mesmo token aqui também é o comportamento correto (o sub-login de
// colaborador de estoque continua existindo como uma segunda checagem por cima desta).
const ROTAS_PUBLICAS = ['/admin/login', '/admin/recuperar-senha', '/admin/resetar-senha'];

function verificarTokenAdmin(req, res, next) {
  const caminho = req.originalUrl.split('?')[0];
  if (ROTAS_PUBLICAS.includes(caminho)) {
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
    // null = admin "dono" da empresa (acesso total); setado = admin de uma unidade só, restrito
    // pelo gate de allowlist logo depois deste middleware (ver server.js).
    req.unidadeId = payload.unidade_id || null;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = verificarTokenAdmin;
