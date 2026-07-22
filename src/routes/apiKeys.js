const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { hashChave } = require('../middleware/apiKeyAuth');
const { permiteApiPublica } = require('../utils/limitesPlano');
const validate = require('../middleware/validate');
const { apiKeyCriarSchema } = require('../schemas');

const router = express.Router();

// :empresaId no path é ignorado de propósito: usar req.empresaId evita que um admin
// autenticado liste as chaves de API de outro tenant só trocando o ID na URL.
router.get('/admin/api-keys/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, nome, key_preview, ativo, criado_em, ultimo_uso_em')
    .eq('empresa_id', req.empresaId)
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erro ao listar chaves.' });
  res.json(data);
});

router.post('/admin/api-keys', validate(apiKeyCriarSchema), async (req, res) => {
  const { nome } = req.body;
  const empresa_id = req.empresaId;

  if (!(await permiteApiPublica(empresa_id))) {
    return res.status(403).json({ error: 'A API pública é um recurso exclusivo do plano Enterprise.' });
  }

  const chaveBruta = `sk_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashChave(chaveBruta);
  const keyPreview = `${chaveBruta.slice(0, 12)}...${chaveBruta.slice(-4)}`;

  const { data, error } = await supabase
    .from('api_keys')
    .insert({ empresa_id, nome: nome.trim(), key_hash: keyHash, key_preview: keyPreview })
    .select('id, nome, key_preview, criado_em')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao gerar chave.' });

  // A chave completa só é retornada UMA VEZ, nesta resposta. Depois disso só o preview
  // fica disponível, igual todo provedor de API key sério faz.
  res.status(201).json({ ...data, chave: chaveBruta });
});

router.delete('/admin/api-keys/:id', async (req, res) => {
  // Filtra por empresa_id também: sem isso, qualquer admin autenticado podia revogar a
  // chave de outro tenant só acertando o ID (que é sequencial/previsível).
  const { data, error } = await supabase
    .from('api_keys')
    .update({ ativo: false })
    .eq('id', req.params.id)
    .eq('empresa_id', req.empresaId)
    .select('id');

  if (error) return res.status(500).json({ error: 'Erro ao revogar chave.' });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Chave não encontrada.' });
  res.json({ success: true });
});

module.exports = router;
