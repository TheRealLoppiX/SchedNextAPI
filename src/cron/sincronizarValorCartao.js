const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sincronizarValorCartaoCampanha } = require('../services/sincronizarValorCartao');

// Rede de segurança do escalonamento de preço de campanha no CARTÃO (ver
// services/sincronizarValorCartao.js): o webhook do Mercado Pago já ajusta o valor logo depois de
// cada mensalidade paga, mas o ajuste é best-effort. Se ele falhar ou o webhook não chegar, a
// próxima mensalidade sairia de novo no valor promocional. Este cron confere todas as assinaturas
// de cartão em campanha a cada 6h e corrige o valor bem antes da próxima data de cobrança.
// Só altera valor, nunca gera cobrança.
function iniciarSincronizacaoValorCartao() {
  cron.schedule('15 */6 * * *', async () => {
    if (!process.env.MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN) return;

    const { data: empresas, error } = await supabase
      .from('empresas')
      .select('id, plano_plataforma_id, plano_plataforma_pendente_id, gateway_subscription_id, campanha_precificacao_id')
      .eq('plataforma_forma_pagamento', 'cartao')
      .not('gateway_subscription_id', 'is', null)
      .not('campanha_precificacao_id', 'is', null)
      .is('excluida_em', null);

    if (error) return console.error('Erro ao buscar assinaturas de cartão em campanha:', error);

    for (const empresa of empresas || []) {
      try {
        await sincronizarValorCartaoCampanha({
          empresaId: empresa.id,
          preapprovalId: empresa.gateway_subscription_id,
          campanhaId: empresa.campanha_precificacao_id,
          // Pendente = plano pago cuja ativação ainda não foi aplicada (webhook atrasado/perdido).
          planoId: empresa.plano_plataforma_pendente_id || empresa.plano_plataforma_id
        });
      } catch (err) {
        console.error(`Erro ao conferir valor da assinatura de cartão da empresa ${empresa.id}:`, err);
      }
    }
  });
}

module.exports = iniciarSincronizacaoValorCartao;
