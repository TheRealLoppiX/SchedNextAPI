const cron = require('node-cron');
const supabase = require('../config/supabase');

// Início do dia seguinte no fuso de Brasília (03:00 UTC), usado como corte do cancelamento.
function inicioDoProximoDiaBrasilia() {
  const hojeBrasilia = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const corte = new Date(`${hojeBrasilia}T03:00:00Z`);
  corte.setUTCDate(corte.getUTCDate() + 1);
  return corte;
}

// Roda uma vez por dia (03:00 UTC = meia-noite em Brasília): empresas que cancelaram a cobrança
// (cancelamento_agendado=true) caem pro plano Grátis no dia do vencimento, ou seja, usam o plano
// pago até o dia anterior (acesso_ate em routes/empresa.js segue a mesma regra).
function iniciarProcessamentoCancelamentos() {
  cron.schedule('0 3 * * *', async () => {
    console.log('Verificando cancelamentos de assinatura agendados...');

    const { data: planoGratis } = await supabase.from('planos_plataforma').select('id').eq('nome', 'Grátis').maybeSingle();
    if (!planoGratis) return console.error('Plano Grátis não encontrado, abortando processamento de cancelamentos.');

    const { data: empresas, error } = await supabase
      .from('empresas')
      .select('id, nome')
      .eq('cancelamento_agendado', true)
      .lt('proxima_cobranca_em', inicioDoProximoDiaBrasilia().toISOString());

    if (error) return console.error('Erro ao buscar cancelamentos agendados:', error);

    for (const empresa of empresas || []) {
      const { error: updError } = await supabase
        .from('empresas')
        .update({
          plano_plataforma_id: planoGratis.id,
          status_assinatura: 'ativa',
          proxima_cobranca_em: null,
          cancelamento_agendado: false
        })
        .eq('id', empresa.id);

      if (updError) console.error(`Erro ao processar cancelamento de ${empresa.nome}:`, updError);
      else console.log(`${empresa.nome} passou pro plano Grátis (cancelamento agendado processado).`);
    }

    // Empresas com plano concedido por chave de ativação (ver routes/chavesAtivacao.js) cujo
    // prazo já passou: mesma regra do cancelamento acima, cai pro Grátis automaticamente. Se a
    // empresa tiver cobrança recorrente própria em andamento (proxima_cobranca_em setado), o
    // plano pago dela é preservado — a chave só derruba quem estava usando o plano de graça
    // por causa dela.
    const { data: empresasComChaveExpirada, error: errChave } = await supabase
      .from('empresas')
      .select('id, nome, proxima_cobranca_em')
      .not('chave_ativacao_expira_em', 'is', null)
      .lte('chave_ativacao_expira_em', new Date().toISOString());

    if (errChave) return console.error('Erro ao buscar chaves de ativação expiradas:', errChave);

    for (const empresa of empresasComChaveExpirada || []) {
      const atualizacao = { chave_ativacao_expira_em: null };
      if (!empresa.proxima_cobranca_em) {
        atualizacao.plano_plataforma_id = planoGratis.id;
        atualizacao.status_assinatura = 'ativa';
      }

      const { error: updError } = await supabase.from('empresas').update(atualizacao).eq('id', empresa.id);
      if (updError) console.error(`Erro ao processar expiração de chave de ${empresa.nome}:`, updError);
      else console.log(`${empresa.nome}: chave de ativação expirada${atualizacao.plano_plataforma_id ? ' — passou pro plano Grátis' : ' (mantido plano com cobrança própria)'}.`);
    }
  });
}

module.exports = iniciarProcessamentoCancelamentos;
