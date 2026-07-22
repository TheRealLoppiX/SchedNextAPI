const supabase = require('../config/supabase');

// Hoje o tenant (empresa) é identificado de duas formas: por slug na URL/query nas rotas
// públicas do cliente final (?empresa=slug), ou pelo empresa_id já decodificado do JWT nas
// rotas /admin/* (ver middleware/adminAuth.js). Quando a plataforma tiver domínio próprio,
// o plano é resolver o tenant pelo subdomínio do header Host em vez do slug na URL. Este
// arquivo é o único lugar que deve mudar quando isso acontecer, em vez de reescrever cada rota.
function obterSlugTenant(req) {
  // TODO(domínio): quando houver domínio próprio, extrair o subdomínio de req.hostname aqui
  // e usá-lo no lugar do slug vindo de query/params, sem tocar nas rotas que chamam esta função.
  return req.query.empresa || req.params.empresaSlug || req.params.slug || null;
}

async function resolverEmpresaPorSlug(slug, campos = 'id, nome, nome_fantasia, logo_url, cor_principal, horarios_funcionamento, vertical, plano_plataforma_id') {
  if (!slug) return { empresa: null, error: null };

  const { data, error } = await supabase
    .from('empresas')
    .select(campos)
    .eq('slug', slug)
    .maybeSingle();

  return { empresa: data, error };
}

module.exports = { obterSlugTenant, resolverEmpresaPorSlug };
