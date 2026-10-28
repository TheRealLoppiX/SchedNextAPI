const crypto = require('crypto');
const express = require('express');
const supabase = require('../config/supabase');
const { processarMensagem } = require('../services/whatsapp/bot');
const { enviarMensagem } = require('../services/whatsapp/provider');
const { identificarRemetente, deveResponder } = require('../services/whatsapp/contatosBot');
const { liberarOuAvisarForaDoHorario } = require('../services/whatsapp/horarioBot');
const { whatsappWebhookLimiter } = require('../middleware/rateLimiters');
const { empresaForaDoAr } = require('../utils/tenantContext');
const { registrarResposta } = require('../services/prospeccao');

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
    // Em contas novas o WhatsApp manda o remetente como LID (@lid), com o número real (quando
    // existe) em remoteJidAlt/senderPn. Antes só o @s.whatsapp.net era removido: quem chegava por
    // LID virava telefone "123@lid", o bot não reconhecia o cadastro e respondia pra um número
    // inexistente. Ver identificarRemetente em services/whatsapp/contatosBot.js.
    const remetente = identificarRemetente(key);
    const telefone = remetente.telefone;
    const instancia = req.body?.instance;

    if (!telefone || !texto || !instancia) return;

    // WhatsApp de prospecção da SchedNext (admin absoluto): resposta de prospect não vai pro bot
    // de nenhuma empresa. Em contas novas o WhatsApp manda o remetente como LID (@lid) e o
    // número real vem em senderPn/remoteJidAlt.
    const telefoneReal = String(key.senderPn || key.remoteJidAlt || key.remoteJid || '').split('@')[0].replace(/\D/g, '');
    if (await registrarResposta(instancia, telefoneReal, texto)) return;

    const { data: empresa } = await supabase
      .from('empresas')
      .select('id, status_assinatura, excluida_em, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot), whatsapp_bot_contatos_modo')
      .eq('whatsapp_phone_number_id', instancia)
      .maybeSingle();

    // Empresa suspensa/excluída pelo admin absoluto: o bot fica mudo, igual ao painel e ao site.
    if (!empresa || empresaForaDoAr(empresa) || !empresa.plano_plataforma?.permite_whatsapp_bot) return;

    // Seleção de contatos (configurável em /admin/whatsapp, ver services/whatsapp/contatosBot.js)
    // — de propósito antes até da checagem de horário: um contato que o bot não atende não deve
    // nem receber o aviso de "fora do horário", só silêncio total.
    if (!(await deveResponder(empresa, remetente))) return;

    // Horário de funcionamento do bot (opcional, ver services/whatsapp/horarioBot.js): fora dele,
    // avisa uma vez por período fechado e não passa a mensagem pro bot.
    if (!(await liberarOuAvisarForaDoHorario({ empresaId: empresa.id, telefone, instancia, enviarMensagem }))) return;

    await processarMensagem({ empresaId: empresa.id, telefone, texto, instancia });
  } catch (err) {
    console.error('Erro ao processar mensagem do WhatsApp:', err);
  }
});

module.exports = router;
