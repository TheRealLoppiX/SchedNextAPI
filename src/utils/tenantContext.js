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

// Empresa suspensa pelo admin absoluto (ou excluída) sai do ar também no site público, não só no
// painel: o resolver devolve empresa null + indisponivel, e as rotas respondem com
// EMPRESA_INDISPONIVEL em vez de "não encontrada" (o frontend mostra uma tela própria pra isso).
const MSG_EMPRESA_INDISPONIVEL = 'Este estabelecimento está temporariamente indisponível.';

// Também usado pelo bot e pelos envios automáticos de WhatsApp/e-mail (routes/whatsapp.js e
// cron/*), que param junto com o painel e o site.
function empresaForaDoAr(empresa) {
  return empresa?.status_assinatura === 'suspensa' || !!empresa?.excluida_em;
}

function respostaEmpresaIndisponivel(res) {
  return res.status(403).json({ code: 'EMPRESA_INDISPONIVEL', error: MSG_EMPRESA_INDISPONIVEL, message: MSG_EMPRESA_INDISPONIVEL });
}

async function resolverEmpresaPorSlug(slug, campos = 'id, nome, nome_fantasia, logo_url, cor_principal, horarios_funcionamento, vertical, plano_plataforma_id') {
  if (!slug) return { empresa: null, error: null };

  const { data, error } = await supabase
    .from('empresas')
    .select(`${campos}, status_assinatura, excluida_em`)
    .eq('slug', slug)
    .maybeSingle();

  if (error || !data) return { empresa: null, error };

  const { status_assinatura, excluida_em, ...empresa } = data;
  if (empresaForaDoAr({ status_assinatura, excluida_em })) return { empresa: null, error: null, indisponivel: true };
  return { empresa, error: null };
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

module.exports = { obterSlugTenant, resolverEmpresaPorSlug, respostaEmpresaIndisponivel, empresaForaDoAr, montarUrlTenant };
