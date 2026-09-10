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

// Monta uma URL absoluta e navegável (pra WhatsApp, e-mail, backUrl de checkout) pro site do
// tenant. Não é `${FRONTEND_URL}/${slug}/...` — esse caminho no domínio raiz foi desativado (ver
// App.js/AppRoutes: as rotas /:empresaSlug só existem quando o acesso já veio de um subdomínio
// ou domínio próprio, senão caem no catch-all pra Landing). Cada empresa vive em
// `{slug}.{DOMINIO_RAIZ_PLATAFORMA}`, ou no domínio próprio dela quando o Enterprise
// (dominio_customizado) já foi verificado (ver routes/dominioCustomizado.js).
const DOMINIO_RAIZ_PLATAFORMA = process.env.DOMINIO_RAIZ_PLATAFORMA || 'schednext.com.br';

function montarUrlTenant(empresa, caminho = '/') {
  const base = (empresa.dominio_customizado && empresa.dominio_verificado)
    ? `https://${empresa.dominio_customizado}`
    : `https://${empresa.slug}.${DOMINIO_RAIZ_PLATAFORMA}`;
  return `${base}${caminho}`;
}

module.exports = { obterSlugTenant, resolverEmpresaPorSlug, montarUrlTenant };
