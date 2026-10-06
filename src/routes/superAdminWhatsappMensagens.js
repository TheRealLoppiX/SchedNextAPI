const express = require('express');
const validate = require('../middleware/validate');
const { whatsappBotMensagensSchema } = require('../schemas');
const mensagensBot = require('../services/whatsapp/mensagensBot');

// Mensagens padrão do bot de WhatsApp de todas as empresas (ver services/whatsapp/mensagensBot.js).
// Vale pra toda empresa que não personalizou aquela mensagem no próprio painel. Tudo sob
// /super-admin, então verificarTokenSuperAdmin (server.js) já garantiu que é o dono da plataforma.
const router = express.Router();

router.get('/super-admin/whatsapp-mensagens', async (req, res) => {
  try {
    const valores = await mensagensBot.obterMensagensPlataforma({ semCache: true });
    res.json({ grupos: mensagensBot.catalogo(), valores });
  } catch (err) {
    console.error('Erro ao carregar mensagens padrão do bot:', err);
    res.status(500).json({ error: 'Erro ao carregar as mensagens padrão.' });
  }
});

router.put('/super-admin/whatsapp-mensagens', validate(whatsappBotMensagensSchema), async (req, res) => {
  try {
    const valores = await mensagensBot.salvarMensagensPlataforma(req.body.mensagens);
    res.json({ success: true, valores });
  } catch (err) {
    console.error('Erro ao salvar mensagens padrão do bot:', err);
    res.status(500).json({ error: 'Erro ao salvar as mensagens padrão.' });
  }
});

module.exports = router;
