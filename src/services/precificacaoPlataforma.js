const supabase = require('../config/supabase');
const { resolverPrecoDoCiclo } = require('../utils/precificacao');

// Campanha ativa pro plano AGORA (janela de tempo + toggle ligado) — usada só na hora de
// ENTRAR numa promoção (novo cadastro ou upgrade). Depois que a empresa entra, o preço
// escalonado dela é resolvido por empresa.campanha_precificacao_id direto (ver precoDoCiclo),
// não por essa busca — assim quem já entrou continua com o preço prometido mesmo se a janela
// da campanha fechar antes de terminar os ciclos dela.
async function buscarCampanhaParaNovoCadastro(planoPlataformaId) {
  const agora = new Date().toISOString();
  const { data } = await supabase
    .from('campanhas_precificacao')
    .select('id, nome, campanha_precos_ciclo(numero_ciclo, valor)')
    .eq('plano_plataforma_id', planoPlataformaId)
    .eq('ativa', true)
    .lte('inicio', agora)
    .gte('fim', agora)
    .maybeSingle();
  return data || null;
}

// Campanha que uma empresa já ligada a uma (empresa.campanha_precificacao_id) está seguindo —
// só respeita o toggle `ativa` como kill-switch geral, ignora a janela de tempo de propósito
// (ver comentário da tabela em sql/2026_campanhas_precificacao.sql).
async function buscarCampanhaDaEmpresa(campanhaId) {
  if (!campanhaId) return null;
  const { data } = await supabase
    .from('campanhas_precificacao')
    .select('id, nome, campanha_precos_ciclo(numero_ciclo, valor)')
    .eq('id', campanhaId)
    .eq('ativa', true)
    .maybeSingle();
  return data || null;
}

// Preço do N-ésimo ciclo: usa a campanha se ela definir esse ciclo específico, senão cai no
// preço cheio do plano — cobre tanto "campanha acabou" (kill-switch ou ciclo além do definido)
// quanto "nunca teve campanha nenhuma".
function precoDoCiclo(campanha, numeroCiclo, precoPadrao) {
  return resolverPrecoDoCiclo(campanha?.campanha_precos_ciclo, numeroCiclo, precoPadrao);
}

// Marca o ciclo `cicloRef` de uma empresa como pago. Idempotente via UNIQUE(empresa_id, serie,
// ciclo_ref) em plataforma_cobrancas (serie = contratação atual, ver
// sql/2026_cobranca_obrigatoria_plataforma.sql): se já existia (retry de webhook, cron rodando duas vezes),
// devolve null — quem chama só avança ciclo_cobranca_atual/registra receita quando isto devolve
// um resultado de verdade, nunca em cima de uma repetição.
async function confirmarCicloPlataforma({ empresaId, serie = 0, cicloRef, valor, formaPagamento, mercadopagoPaymentId }) {
  const { data, error } = await supabase
    .from('plataforma_cobrancas')
    .insert({
      empresa_id: empresaId,
      serie,
      ciclo_ref: cicloRef,
      valor,
      forma_pagamento: formaPagamento,
      mercadopago_payment_id: mercadopagoPaymentId || null,
      status: 'pago',
      pago_em: new Date().toISOString()
    })
    .select('id')
    .maybeSingle();

  if (error) {
    if (error.code !== '23505') console.error('Erro ao confirmar ciclo de cobrança da plataforma:', error);
    return null;
  }
  return data;
}

// Preço cheio travado quando a empresa passou a pagar o plano (ver
// sql/2026_preco_contratado_plataforma.sql) — aumento de preço do plano só vale pra quem assina
// dali em diante. Consulta/escrita separadas e tolerantes a falha: sem a coluna no banco ainda,
// cai no preço atual do plano (comportamento antigo) em vez de derrubar cobrança/webhook.
async function precoCheioDaEmpresa(empresaId, precoPlanoAtual) {
  const { data, error } = await supabase.from('empresas').select('plataforma_preco_contratado').eq('id', empresaId).maybeSingle();
  if (error || data?.plataforma_preco_contratado == null) return Number(precoPlanoAtual ?? 0);
  return Number(data.plataforma_preco_contratado);
}

async function registrarPrecoContratado(empresaId, planoId) {
  const { data: plano } = await supabase.from('planos_plataforma').select('preco_mensal').eq('id', planoId).maybeSingle();
  if (plano?.preco_mensal == null) return;
  const { error } = await supabase.from('empresas').update({ plataforma_preco_contratado: plano.preco_mensal }).eq('id', empresaId);
  if (error) console.error('Erro ao registrar preço contratado da plataforma:', error);
}

module.exports = {
  buscarCampanhaParaNovoCadastro,
  buscarCampanhaDaEmpresa,
  precoDoCiclo,
  confirmarCicloPlataforma,
  precoCheioDaEmpresa,
  registrarPrecoContratado
};
