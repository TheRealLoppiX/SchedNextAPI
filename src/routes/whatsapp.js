const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { processarMensagem } = require('../services/whatsapp/bot');
const { whatsappWebhookLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// Compara em tempo constante pra não vazar o segredo por timing (quanto mais caracteres batem
// no início, mais devagar uma comparação ingênua com === responde) — mesmo cuidado que já existe
// pra outros segredos do projeto. Tamanhos diferentes nunca são iguais, e timingSafeEqual exige
// buffers do mesmo tamanho pra não lançar exceção.
function segredoValido(recebido) {
  const esperado = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!esperado || !recebido || recebido.length !== esperado.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado));
}

// Recebe eventos do Evolution API (self-hosted, ver services/whatsapp/provider.js). Diferente
// da Meta, não tem handshake de verificação por GET nem assinatura de payload — o webhook é
// registrado com um segredo embutido na própria URL (?secret=..., ver urlWebhookComSegredo em
// provider.js) quando a instância é criada. Sem essa checagem, esta rota era pública de verdade:
// qualquer um podia forjar um POST com `instance` = slug de qualquer empresa (público, é a URL
// do site dela) e `remoteJid` = telefone de qualquer cliente, e o bot tratava como mensagem real
// daquele cliente — dava pra ver/cancelar agendamento alheio, criar cadastro vinculado ao
// telefone de outra pessoa, e brute-forçar o código de confirmação de 6 dígitos sem nem precisar
// passar por um WhatsApp de verdade.
router.post('/whatsapp/webhook', whatsappWebhookLimiter, async (req, res) => {
  if (!segredoValido(req.query?.secret)) return res.sendStatus(401);

  // Sempre responde 200 rápido a partir daqui, que é o esperado por qualquer provedor de
  // webhook, mesmo que o processamento abaixo não gere resposta (evita retentativas desnecessárias).
  res.sendStatus(200);

  try {
    if (req.body?.event !== 'messages.upsert') return;

    const dadoMsg = req.body?.data?.message ? req.body.data : { message: req.body?.data };
    const key = dadoMsg?.key;
    if (!key || key.fromMe) return; // ignora eco das mensagens que a própria instância envia

    // Mensagem de grupo tem remoteJid terminando em "@g.us" (não "@s.whatsapp.net") — sem esse
    // filtro, o .replace('@s.whatsapp.net', '') abaixo não batia em nada, e o JID do grupo inteiro
    // virava "telefone" de uma sessão do bot, tratando o grupo como se fosse um único cliente.
    if ((key.remoteJid || '').endsWith('@g.us')) return;

    // Além de texto normal, também trata toques em botão/lista (bot.js manda esses IDs iguais aos
    // números do menu numerado, então o resto do fluxo nem precisa saber que veio de um toque em
    // vez de o cliente digitar o número).
    const conteudoMsg = dadoMsg?.message || {};
    const texto =
      conteudoMsg.conversation ||
      conteudoMsg.extendedTextMessage?.text ||
      conteudoMsg.buttonsResponseMessage?.selectedButtonId ||
      conteudoMsg.listResponseMessage?.singleSelectReply?.selectedRowId ||
      conteudoMsg.templateButtonReplyMessage?.selectedId ||
      '';
    const telefone = (key.remoteJid || '').replace('@s.whatsapp.net', '');
    const instancia = req.body?.instance;

    if (!telefone || !texto || !instancia) return;

    const { data: empresa } = await supabase
      .from('empresas')
      .select('id, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot)')
      .eq('whatsapp_phone_number_id', instancia)
      .maybeSingle();

    if (!empresa || !empresa.plano_plataforma?.permite_whatsapp_bot) return;

    await processarMensagem({ empresaId: empresa.id, telefone, texto, instancia });
  } catch (err) {
    console.error('Erro ao processar mensagem do WhatsApp:', err);
  }
});

module.exports = router;
