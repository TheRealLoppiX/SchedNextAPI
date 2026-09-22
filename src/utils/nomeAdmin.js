// super_admins não tem coluna de nome (só email, ver sql/2026_super_admins_foto.sql e
// routes/superAdmin.js) — pra identificar quem respondeu no módulo de suporte (ver
// routes/suporte.js e superAdminSuporte.js) sem exigir migração nem cadastro extra, deriva um
// nome de exibição a partir da parte antes do @ do e-mail (ex: "arthur@schednext.com.br" ->
// "Arthur"). Funciona bem porque o e-mail de cada super admin já é o primeiro nome dele.
function nomeDoEmail(email) {
  if (!email) return 'Time SchedNext';
  const local = String(email).split('@')[0] || '';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

module.exports = { nomeDoEmail };
