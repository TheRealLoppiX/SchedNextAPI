const express = require('express');
const supabase = require('../config/supabase');
const { processarMensagem } = require('../services/whatsapp/bot');

const router = express.Router();

// Handshake de verificação da Meta Cloud API. Chamado uma vez quando o webhook é cadastrado
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
  // Sempre responde 200 rápido, que é o esperado por qualquer provedor de webhook, mesmo que o
  // processamento abaixo não gere resposta (evita retentativas desnecessárias).
  res.sendStatus(200);

  // DIAGNÓSTICO TEMPORÁRIO (remover depois de confirmar que o webhook está sendo alcançado).
  // Ver handoff.md, sessão 2026-07-21.
  console.log('[WhatsApp webhook] payload recebido:', JSON.stringify(req.body));

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const mensagem = value?.messages?.[0];
    if (!mensagem) {
      console.log('[WhatsApp webhook] sem messages[0] no payload, ignorando');
      return;
    }

    const phoneNumberId = value?.metadata?.phone_number_id;
    const telefone = mensagem.from;
    const texto = mensagem.text?.body || '';

    console.log(`[WhatsApp webhook] mensagem de ${telefone} pro phone_number_id ${phoneNumberId}: "${texto}"`);

    const { data: empresa } = await supabase
      .from('empresas')
      .select('id, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot)')
      .eq('whatsapp_phone_number_id', phoneNumberId)
      .maybeSingle();

    if (!empresa || !empresa.plano_plataforma?.permite_whatsapp_bot) {
      console.log(`[WhatsApp webhook] nenhuma empresa habilitada encontrada pro phone_number_id ${phoneNumberId}`);
      return;
    }

    await processarMensagem({ empresaId: empresa.id, telefone, texto });
  } catch (err) {
    console.error('Erro ao processar mensagem do WhatsApp:', err);
  }
});

module.exports = router;
