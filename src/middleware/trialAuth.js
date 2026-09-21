const supabase = require('../config/supabase');

// Fim do período de teste: depois de trial_expira_em (ver sql/2026_planos_ativo_trial_antifraude.sql)
// o painel do admin fica travado até a empresa assinar um plano pago — só sobram as rotas de
// conta/assinatura pra ela conseguir escolher e pagar um plano. O frontend reconhece o código
// TRIAL_EXPIRADO e leva o cliente direto pra tela de Assinatura.
//
// O bloqueio vale enquanto a empresa NÃO tiver: plano pago em dia, chave promocional em
// vigor ou teste de plano do admin absoluto em vigor. Como trial_expira_em nunca é zerado,
// cair de volta pro Grátis depois (cancelar plano, chave expirada) volta a travar — o teste
// grátis é um só por conta.

const CACHE_MS = 60 * 1000;
const cache = new Map();

function rotaLiberada(req) {
  const url = req.originalUrl;
  return (
    url.startsWith('/admin/assinatura-plataforma/') ||
    url.startsWith('/admin/empresa/contato-enterprise') ||
    (req.method === 'GET' && url.startsWith('/admin/empresa/'))
  );
}

async function carregarSituacao(empresaId) {
  const cacheado = cache.get(empresaId);
  if (cacheado && cacheado.ate > Date.now()) return cacheado.expirado;

  const { data } = await supabase
    .from('empresas')
    .select('trial_expira_em, chave_ativacao_expira_em, plano_teste_expira_em, status_assinatura, plano_plataforma:plano_plataforma_id(preco_mensal)')
    .eq('id', empresaId)
    .maybeSingle();

  const agora = Date.now();
  const emVigor = (v) => v && new Date(v).getTime() > agora;
  const planoPagoEmDia = data?.plano_plataforma && data.plano_plataforma.preco_mensal !== 0 && data.status_assinatura === 'ativa';

  const expirado = !!data?.trial_expira_em
    && new Date(data.trial_expira_em).getTime() <= agora
    && !planoPagoEmDia
    && !emVigor(data.chave_ativacao_expira_em)
    && !emVigor(data.plano_teste_expira_em);

  cache.set(empresaId, { expirado, ate: agora + CACHE_MS });
  return expirado;
}

async function bloquearTrialExpirado(req, res, next) {
  if (!req.empresaId || rotaLiberada(req)) return next();

  try {
    if (await carregarSituacao(req.empresaId)) {
      return res.status(403).json({
        code: 'TRIAL_EXPIRADO',
        error: 'Seu período de teste acabou. Assine um plano para continuar usando a SchedNext.'
      });
    }
  } catch (e) {
    // Falha de consulta não pode derrubar o painel de quem está em dia.
    console.error('Erro ao checar fim do período de teste:', e);
  }
  next();
}

// Chamado quando a situação da empresa muda na hora (ex: acabou de assinar), pra não esperar o cache.
function limparCacheTrial(empresaId) {
  cache.delete(empresaId);
}

module.exports = { bloquearTrialExpirado, limparCacheTrial };
