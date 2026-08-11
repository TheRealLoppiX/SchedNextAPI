const cron = require('node-cron');
const supabase = require('../config/supabase');
const { renovarToken } = require('../services/mercadopago');

// Roda uma vez por dia: o access_token do Mercado Pago de cada empresa conectada expira (o
// próprio Mercado Pago manda expires_in na resposta do OAuth, tipicamente 180 dias) — renova
// com antecedência pra nunca deixar uma cobrança de Pix falhar por token vencido. Mesmo padrão
// de "loop e segue mesmo se uma linha falhar" já usado em cron/assinaturas.js.
function iniciarRenovacaoTokenMercadoPago() {
  cron.schedule('0 4 * * *', async () => {
    console.log('Verificando tokens do Mercado Pago perto de expirar...');

    const emQuinzeDias = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

    const { data: empresas, error } = await supabase
      .from('empresas')
      .select('id, nome, mercadopago_refresh_token')
      .not('mercadopago_refresh_token', 'is', null)
      .lte('mercadopago_token_expira_em', emQuinzeDias);

    if (error) return console.error('Erro ao buscar tokens do Mercado Pago a renovar:', error);

    for (const empresa of empresas || []) {
      try {
        const token = await renovarToken(empresa.mercadopago_refresh_token);
        const expiraEm = new Date(Date.now() + Number(token.expires_in) * 1000).toISOString();

        await supabase
          .from('empresas')
          .update({
            mercadopago_access_token: token.access_token,
            mercadopago_refresh_token: token.refresh_token,
            mercadopago_token_expira_em: expiraEm
          })
          .eq('id', empresa.id);

        console.log(`Token do Mercado Pago renovado para ${empresa.nome}.`);
      } catch (err) {
        console.error(`Erro ao renovar token do Mercado Pago de ${empresa.nome}:`, err);
      }
    }
  });
}

module.exports = iniciarRenovacaoTokenMercadoPago;
