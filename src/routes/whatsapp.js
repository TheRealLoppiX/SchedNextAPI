const express = require('express');
const supabase = require('../config/supabase');
const { processarMensagem } = require('../services/whatsapp/bot');

const router = express.Router();

// Handshake de verificação da Meta Cloud API — chamado uma vez quando o webhook é cadastrado
// no Meta App Dashboard (WhatsApp > Configuration > Webhook).
router.get('/whatsapp/webhook', (req, res) => {
  const modo = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const desafio = req.query['hub.challenge'];

  if (modo === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(desafio);
  }
  res.sendStatus(403);
});

// Recebe mensagens inbound. Formato de payload da Meta Cloud API
// (entry[].changes[].value.{metadata,messages}).
router.post('/whatsapp/webhook', async (req, res) => {
  // Sempre responde 200 rápido — é o esperado por qualquer provedor de webhook, mesmo que o
  // processamento abaixo não gere resposta (evita retentativas desnecessárias).
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const mensagem = value?.messages?.[0];
    if (!mensagem) return;

    const phoneNumberId = value?.metadata?.phone_number_id;
    const telefone = mensagem.from;
    const texto = mensagem.text?.body || '';

    const { data: empresa } = await supabase
      .from('empresas')
      .select('id, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot)')
      .eq('whatsapp_phone_number_id', phoneNumberId)
      .maybeSingle();

    if (!empresa || !empresa.plano_plataforma?.permite_whatsapp_bot) return;

    await processarMensagem({ empresaId: empresa.id, telefone, texto });
  } catch (err) {
    console.error('Erro ao processar mensagem do WhatsApp:', err);
  }
});

module.exports = router;
