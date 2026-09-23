const supabase = require('../config/supabase');

// Campanhas promocionais de preço escalonado por ciclo pra assinatura de CLIENTE FINAL (mensalidade
// que ele paga pra própria barbearia — não confundir com services/precificacaoPlataforma.js, que
// é o mesmo conceito só que pro plano da PLATAFORMA). Cada barbearia gerencia as próprias
// campanhas, sempre escopadas por empresa_id — feature de plano, ver
// utils/limitesPlano.js:permiteCampanhasAssinatura.

// Campanha ativa da empresa pro plano AGORA (janela de tempo + toggle ligado) — usada só na hora
// de um cliente ENTRAR numa promoção (nova assinatura). Depois que ele entra, o preço
// escalonado dele é resolvido por usuario.campanha_assinatura_id direto (ver
// buscarCampanhaDoCliente), não por essa busca — assim quem já entrou continua com o preço
// prometido mesmo se a janela da campanha fechar antes de terminar os ciclos dele.
async function buscarCampanhaParaNovoCadastro(empresaId, planoAssinaturaId) {
  const agora = new Date().toISOString();
  const { data } = await supabase
    .from('campanhas_assinatura')
    .select('id, nome, campanha_assinatura_precos_ciclo(numero_ciclo, valor)')
    .eq('empresa_id', empresaId)
    .eq('plano_assinatura_id', planoAssinaturaId)
    .eq('ativa', true)
    .lte('inicio', agora)
    .gte('fim', agora)
    .maybeSingle();
  return data || null;
}

// Campanha que um cliente já ligado a uma (usuario.campanha_assinatura_id) está seguindo — só
// respeita o toggle `ativa` como kill-switch geral, ignora a janela de tempo de propósito (mesmo
// princípio de precificacaoPlataforma.js:buscarCampanhaDaEmpresa).
async function buscarCampanhaDoCliente(campanhaId) {
  if (!campanhaId) return null;
  const { data } = await supabase
    .from('campanhas_assinatura')
    .select('id, nome, campanha_assinatura_precos_ciclo(numero_ciclo, valor)')
    .eq('id', campanhaId)
    .eq('ativa', true)
    .maybeSingle();
  return data || null;
}

// Preço do N-ésimo ciclo: usa a campanha se ela definir esse ciclo específico, senão cai no
// preço cheio do plano.
function precoDoCiclo(campanha, numeroCiclo, precoPadrao) {
  if (!campanha) return Number(precoPadrao);
  const linha = (campanha.campanha_assinatura_precos_ciclo || []).find((p) => p.numero_ciclo === numeroCiclo);
  return linha ? Number(linha.valor) : Number(precoPadrao);
}

module.exports = { buscarCampanhaParaNovoCadastro, buscarCampanhaDoCliente, precoDoCiclo };
