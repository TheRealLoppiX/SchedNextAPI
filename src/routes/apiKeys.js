const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { hashChave } = require('../middleware/apiKeyAuth');
const { permiteApiPublica } = require('../utils/limitesPlano');

const router = express.Router();

router.get('/admin/api-keys/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, nome, key_preview, ativo, criado_em, ultimo_uso_em')
    .eq('empresa_id', req.params.empresaId)
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erro ao listar chaves.' });
  res.json(data);
});

router.post('/admin/api-keys', async (req, res) => {
  const { empresa_id, nome } = req.body;

  if (!(await permiteApiPublica(empresa_id))) {
    return res.status(403).json({ error: 'A API pública é um recurso exclusivo do plano Enterprise.' });
  }

  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Dê um nome pra essa chave (ex: "Integração site institucional").' });

  const chaveBruta = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashChave(chaveBruta);
  const keyPreview = `${chaveBruta.slice(0, 12)}...${chaveBruta.slice(-4)}`;

  const { data, error } = await supabase
    .from('api_keys')
    .insert({ empresa_id, nome: nome.trim(), key_hash: keyHash, key_preview: keyPreview })
    .select('id, nome, key_preview, criado_em')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao gerar chave.' });

  // A chave completa só é retornada UMA VEZ, nesta resposta — depois disso só o preview
  // fica disponível, igual todo provedor de API key sério faz.
  res.status(201).json({ ...data, chave: chaveBruta });
});

router.delete('/admin/api-keys/:id', async (req, res) => {
  const { error } = await supabase.from('api_keys').update({ ativo: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao revogar chave.' });
  res.json({ success: true });
});

module.exports = router;
