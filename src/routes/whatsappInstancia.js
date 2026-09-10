const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { whatsappTesteSchema, whatsappBotConfigSchema } = require('../schemas');
const { permiteWhatsappBot, permiteIA } = require('../utils/limitesPlano');
const { estaConfigurado, criarInstancia, obterQrCode, obterStatusConexao, removerInstancia, enviarMensagem } = require('../services/whatsapp/provider');

const router = express.Router();

// Cada empresa tem sua própria instância na Evolution API (self-hosted, ver
// services/whatsapp/provider.js) — o nome da instância é o `slug` da empresa (já único, usado
// também no subdomínio) e fica guardado em `empresas.whatsapp_phone_number_id` (coluna
// reaproveitada da era Meta Cloud API). Bot de WhatsApp é recurso gated por plano
// (permite_whatsapp_bot, ver utils/limitesPlano.js), igual domínio próprio e relatórios avançados.

router.get('/admin/whatsapp', async (req, res) => {
  const empresa_id = req.empresaId;

  const permitido = await permiteWhatsappBot(empresa_id);
  if (!permitido) return res.json({ permitido: false, conectado: false, instancia: null, estado: null });

  const { data: empresa, error } = await supabase
    .from('empresas')
    .select('whatsapp_phone_number_id, whatsapp_bot_modo, whatsapp_bot_nome, whatsapp_bot_personalidade, whatsapp_bot_boas_vindas, whatsapp_bot_temperatura')
    .eq('id', empresa_id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar configuração de WhatsApp.' });

  // Modo livre/personalidade/temperatura são recurso de IA (plano Profissional/Enterprise, ver
  // permiteIA) — boas_vindas fica liberado pra qualquer plano com o bot ligado, já que é só um
  // texto fixo substituindo outro texto fixo, sem custo de IA envolvido.
  const botConfig = {
    permiteIa: await permiteIA(empresa_id),
    modo: empresa?.whatsapp_bot_modo || 'guiado',
    nome: empresa?.whatsapp_bot_nome || '',
    personalidade: empresa?.whatsapp_bot_personalidade || '',
    boasVindas: empresa?.whatsapp_bot_boas_vindas || '',
    temperatura: empresa?.whatsapp_bot_temperatura != null ? Number(empresa.whatsapp_bot_temperatura) : 0.6
  };

  const instancia = empresa?.whatsapp_phone_number_id || null;
  if (!instancia) return res.json({ permitido: true, conectado: false, instancia: null, estado: null, botConfig });

  // Esta rota é consultada pelo front a cada poucos segundos (tela de conexão do WhatsApp) —
  // sem o try/catch, uma falha/lentidão pontual da Evolution API/VPS derrubava o polling com um
  // 500 cru em vez de simplesmente reportar "não deu pra checar agora" e tentar de novo no
  // próximo ciclo.
  try {
    const status = await obterStatusConexao(instancia);
    res.json({ permitido: true, instancia, estado: status.state, conectado: status.state === 'open', botConfig });
  } catch (err) {
    console.error('Erro ao consultar status da conexão de WhatsApp:', err);
    res.json({ permitido: true, instancia, estado: null, conectado: false, erroConsulta: true, botConfig });
  }
});

// Personalidade/comportamento do bot (ver services/whatsapp/bot.js e services/whatsapp/agente.js).
// Fica numa rota própria (em vez de dentro de /admin/whatsapp/conectar) porque é editável a
// qualquer momento, conectado ou não — não depende de ter QR Code escaneado.
router.put('/admin/whatsapp/bot-config', validate(whatsappBotConfigSchema), async (req, res) => {
  const empresa_id = req.empresaId;
  if (!(await permiteWhatsappBot(empresa_id))) return res.status(403).json({ error: 'Recurso não disponível no seu plano.' });

  const iaLiberada = await permiteIA(empresa_id);
  const { modo, nome, personalidade, boas_vindas, temperatura } = req.body;

  const atualizacao = { whatsapp_bot_boas_vindas: boas_vindas || null };

  // Sem IA no plano, essas colunas ficam travadas nos valores padrão — mesmo que o front não
  // devesse mandar isso pra uma empresa sem o recurso, a rota não confia só na UI.
  if (iaLiberada) {
    if (modo !== undefined) atualizacao.whatsapp_bot_modo = modo;
    if (nome !== undefined) atualizacao.whatsapp_bot_nome = nome || null;
    if (personalidade !== undefined) atualizacao.whatsapp_bot_personalidade = personalidade || null;
    if (temperatura !== undefined) atualizacao.whatsapp_bot_temperatura = temperatura;
  }

  const { error } = await supabase.from('empresas').update(atualizacao).eq('id', empresa_id);
  if (error) {
    console.error('Erro ao salvar configuração do bot de WhatsApp:', error);
    return res.status(500).json({ error: 'Erro ao salvar configuração do bot.' });
  }
  res.json({ success: true });
});

// Envia uma mensagem de teste pro próprio admin confirmar que o envio outbound está de fato
// funcionando, sem precisar simular uma conversa inteira do bot escrevendo pro número conectado.
router.post('/admin/whatsapp/testar', validate(whatsappTesteSchema), async (req, res) => {
  const empresa_id = req.empresaId;
  if (!(await permiteWhatsappBot(empresa_id))) return res.status(403).json({ error: 'Recurso não disponível no seu plano.' });

  const { data: empresa } = await supabase.from('empresas').select('whatsapp_phone_number_id').eq('id', empresa_id).maybeSingle();
  if (!empresa?.whatsapp_phone_number_id) return res.status(400).json({ error: 'Conecte o WhatsApp antes de enviar um teste.' });

  const telefone = String(req.body.telefone).replace(/\D/g, '');
  const numeroCompleto = telefone.startsWith('55') ? telefone : `55${telefone}`;

  try {
    const resultado = await enviarMensagem(empresa.whatsapp_phone_number_id, numeroCompleto, 'Mensagem de teste do SchedNext: se você recebeu isso, seu bot de agendamento está pronto para responder clientes por aqui. ✅');
    if (resultado.simulado) {
      return res.status(503).json({ error: 'Integração de WhatsApp não configurada no servidor — mensagem não enviada de verdade.' });
    }
    if (!resultado.enviado) {
      return res.status(502).json({ error: 'Não foi possível enviar a mensagem de teste. Confira se o número ainda está conectado.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao enviar mensagem de teste de WhatsApp:', err);
    res.status(500).json({ error: 'Erro ao enviar a mensagem de teste.' });
  }
});

router.post('/admin/whatsapp/conectar', async (req, res) => {
  const empresa_id = req.empresaId;

  if (!(await permiteWhatsappBot(empresa_id))) {
    return res.status(403).json({ error: 'Agendamento por WhatsApp é um recurso exclusivo dos planos Profissional e Enterprise. Fale com o suporte para fazer upgrade.' });
  }
  if (!estaConfigurado()) {
    return res.status(503).json({ error: 'Integração de WhatsApp não está disponível no momento.' });
  }

  const { data: empresa, error } = await supabase
    .from('empresas')
    .select('slug, whatsapp_phone_number_id')
    .eq('id', empresa_id)
    .maybeSingle();
  if (error || !empresa) return res.status(500).json({ error: 'Erro ao buscar empresa.' });

  const instancia = empresa.whatsapp_phone_number_id || empresa.slug;

  try {
    let qrcode;
    if (!empresa.whatsapp_phone_number_id) {
      // Primeira conexão: cria a instância do zero (já vem com o QR Code na resposta).
      const criada = await criarInstancia(instancia);
      qrcode = criada.qrcode;
      await supabase.from('empresas').update({ whatsapp_phone_number_id: instancia }).eq('id', empresa_id);
    } else {
      // Instância já existe (ex: desconectou o celular sem remover) — só pede um QR novo.
      qrcode = await obterQrCode(instancia);
    }

    if (!qrcode?.base64) {
      return res.status(409).json({ error: 'Não foi possível gerar o QR Code agora. Se o WhatsApp já estiver conectado, não é preciso escanear de novo.' });
    }

    res.json({ instancia, qrcode: qrcode.base64 });
  } catch (err) {
    console.error('Erro ao conectar instância de WhatsApp:', err);
    res.status(500).json({ error: err.message || 'Erro ao conectar com o WhatsApp.' });
  }
});

router.get('/admin/whatsapp/qrcode', async (req, res) => {
  const empresa_id = req.empresaId;
  if (!(await permiteWhatsappBot(empresa_id))) return res.status(403).json({ error: 'Recurso não disponível no seu plano.' });

  const { data: empresa } = await supabase.from('empresas').select('whatsapp_phone_number_id').eq('id', empresa_id).maybeSingle();
  if (!empresa?.whatsapp_phone_number_id) return res.status(400).json({ error: 'Nenhuma instância criada ainda. Clique em "Conectar".' });

  try {
    const qrcode = await obterQrCode(empresa.whatsapp_phone_number_id);
    if (!qrcode?.base64) return res.status(409).json({ error: 'Sem QR Code pendente — o WhatsApp já deve estar conectado.' });
    res.json({ qrcode: qrcode.base64 });
  } catch (err) {
    console.error('Erro ao buscar novo QR Code:', err);
    res.status(500).json({ error: err.message || 'Erro ao buscar QR Code.' });
  }
});

router.delete('/admin/whatsapp', async (req, res) => {
  const empresa_id = req.empresaId;

  const { data: empresa } = await supabase.from('empresas').select('whatsapp_phone_number_id').eq('id', empresa_id).maybeSingle();
  if (!empresa?.whatsapp_phone_number_id) return res.json({ success: true });

  try {
    await removerInstancia(empresa.whatsapp_phone_number_id);
  } catch (err) {
    console.error('Erro ao remover instância na Evolution API:', err);
    // Segue e limpa do nosso lado mesmo assim — não deixar o admin travado por causa da VPS.
  }

  await supabase.from('empresas').update({ whatsapp_phone_number_id: null }).eq('id', empresa_id);
  res.json({ success: true });
});

module.exports = router;
