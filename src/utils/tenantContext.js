const supabase = require('../config/supabase');

// O tenant (empresa) é identificado de duas formas: por slug na URL/query nas rotas
// públicas do cliente final (?empresa=slug), ou pelo empresa_id já decodificado do JWT nas
// rotas /admin/* (ver middleware/adminAuth.js). Com o domínio próprio (schednext.com.br) já
// ativo, subdomínios de tenant (ex: minha-empresa.schednext.com.br) só existem na frente do
// Static Site do frontend, não na frente desta API (que continua num único domínio fixo) —
// então quem resolve o subdomínio pra slug é o frontend (ver App.js/utils/tenantSubdominio.js),
// que sempre repassa o slug pra cá do mesmo jeito de antes (query/params). Por isso este
// arquivo não precisa ler req.hostname: o slug já chega resolvido em todas as chamadas.
function obterSlugTenant(req) {
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
