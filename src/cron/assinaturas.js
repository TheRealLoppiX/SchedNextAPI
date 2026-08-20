const cron = require('node-cron');
const supabase = require('../config/supabase');

// Roda uma vez por dia: empresas que cancelaram a cobrança (cancelamento_agendado=true) e
// já passaram da data da próxima cobrança caem pro plano Grátis automaticamente. O cliente
// continua com o plano pago até a data prometida, sem downgrade prematuro.
function iniciarProcessamentoCancelamentos() {
  cron.schedule('0 3 * * *', async () => {
    console.log('Verificando cancelamentos de assinatura agendados...');

    const { data: planoGratis } = await supabase.from('planos_plataforma').select('id').eq('nome', 'Grátis').maybeSingle();
    if (!planoGratis) return console.error('Plano Grátis não encontrado, abortando processamento de cancelamentos.');

    const { data: empresas, error } = await supabase
      .from('empresas')
      .select('id, nome')
      .eq('cancelamento_agendado', true)
      .lte('proxima_cobranca_em', new Date().toISOString());

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
