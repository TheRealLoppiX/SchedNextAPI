const express = require('express');
const supabase = require('../config/supabase');
const { permiteWhatsappBot } = require('../utils/limitesPlano');
const { estaConfigurado, criarInstancia, obterQrCode, obterStatusConexao, removerInstancia } = require('../services/whatsapp/provider');

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
    .select('whatsapp_phone_number_id')
    .eq('id', empresa_id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar configuração de WhatsApp.' });

  const instancia = empresa?.whatsapp_phone_number_id || null;
  if (!instancia) return res.json({ permitido: true, conectado: false, instancia: null, estado: null });

  const status = await obterStatusConexao(instancia);
  res.json({ permitido: true, instancia, estado: status.state, conectado: status.state === 'open' });
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
