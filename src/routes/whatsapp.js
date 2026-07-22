const express = require('express');
const supabase = require('../config/supabase');
const { processarMensagem } = require('../services/whatsapp/bot');

const router = express.Router();

// Recebe eventos do Evolution API (self-hosted, ver services/whatsapp/provider.js). Diferente
// da Meta, não tem handshake de verificação por GET: o webhook é registrado direto via chamada
// à API do Evolution (POST /webhook/set/{instance}) quando a instância é criada, então só existe
// a rota de recebimento (POST) mesmo.
router.post('/whatsapp/webhook', async (req, res) => {
  // Sempre responde 200 rápido, que é o esperado por qualquer provedor de webhook, mesmo que o
  // processamento abaixo não gere resposta (evita retentativas desnecessárias).
  res.sendStatus(200);

  try {
    if (req.body?.event !== 'messages.upsert') return;

    const dadoMsg = req.body?.data?.message ? req.body.data : { message: req.body?.data };
    const key = dadoMsg?.key;
    if (!key || key.fromMe) return; // ignora eco das mensagens que a própria instância envia

    const texto = dadoMsg?.message?.conversation || dadoMsg?.message?.extendedTextMessage?.text || '';
    const telefone = (key.remoteJid || '').replace('@s.whatsapp.net', '');
    const instancia = req.body?.instance;

    if (!telefone || !texto || !instancia) return;

    const { data: empresa } = await supabase
      .from('empresas')
      .select('id, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot)')
      .eq('whatsapp_phone_number_id', instancia)
      .maybeSingle();

    if (!empresa || !empresa.plano_plataforma?.permite_whatsapp_bot) return;

    await processarMensagem({ empresaId: empresa.id, telefone, texto });
  } catch (err) {
    console.error('Erro ao processar mensagem do WhatsApp:', err);
  }
});

module.exports = router;
