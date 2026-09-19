// Script de migração único: reregistra o webhook (com o novo EVOLUTION_WEBHOOK_SECRET embutido
// na URL) de toda empresa que já tem uma instância de WhatsApp conectada. Necessário rodar uma
// vez, manualmente, logo depois de fazer deploy da correção de segurança do webhook — sem isso,
// a Evolution continua chamando a URL antiga (sem ?secret) pras empresas já conectadas, e o bot
// para de responder pra elas (a rota passa a recusar qualquer chamada sem o segredo certo).
//
// Uso: node scripts/reregistrar-webhooks-whatsapp.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const supabase = require('../src/config/supabase');
const { atualizarWebhook } = require('../src/services/whatsapp/provider');

async function main() {
  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id, nome, whatsapp_phone_number_id')
    .not('whatsapp_phone_number_id', 'is', null);

  if (error) {
    console.error('Erro ao buscar empresas com WhatsApp conectado:', error);
    process.exitCode = 1;
    return;
  }

  if (!empresas || empresas.length === 0) {
    console.log('Nenhuma empresa com instância de WhatsApp conectada. Nada a fazer.');
    return;
  }

  console.log(`Reregistrando webhook de ${empresas.length} instância(s)...`);
  for (const empresa of empresas) {
    try {
      await atualizarWebhook(empresa.whatsapp_phone_number_id);
      console.log(`OK  — ${empresa.nome} (${empresa.whatsapp_phone_number_id})`);
    } catch (err) {
      console.error(`FALHOU — ${empresa.nome} (${empresa.whatsapp_phone_number_id}):`, err.message);
      process.exitCode = 1;
    }
  }
}

// Sem process.exit() de propósito: forçar a saída enquanto o cliente do Supabase ainda tem
// handle de rede aberto derruba o processo com um crash nativo do libuv no Windows
// ("UV_HANDLE_CLOSING") — cosmético (o script já tinha terminado e reportado tudo certo antes
// disso), mas alarmante. Deixando o processo encerrar sozinho evita o crash.
main();
