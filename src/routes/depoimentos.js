const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { depoimentosSchema } = require('../schemas');

// Depoimentos de clientes da SchedNext exibidos na landing. Ficam como JSON em
// plataforma_configuracoes ('depoimentos_landing'), sem tabela própria: são poucos e editados só
// pelo admin absoluto. Só entram relatos reais, com autorização do cliente — a landing esconde a
// seção inteira enquanto não houver nenhum ativo.
const router = express.Router();
const CHAVE = 'depoimentos_landing';

async function lerDepoimentos() {
  const { data, error } = await supabase.from('plataforma_configuracoes').select('valor').eq('chave', CHAVE).maybeSingle();
  if (error) throw error;
  try {
    const lista = JSON.parse(data?.valor || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

// Público (landing): só os ativos, sem campos internos.
router.get('/depoimentos', async (req, res) => {
  try {
    const lista = await lerDepoimentos();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(lista.filter((d) => d.ativo !== false).map(({ id, nome, negocio, cidade, texto, nota, foto_url }) => ({ id, nome, negocio, cidade, texto, nota, foto_url })));
  } catch (err) {
    console.error('Erro ao listar depoimentos:', err);
    res.json([]);
  }
});

router.get('/super-admin/depoimentos', async (req, res) => {
  try {
    res.json(await lerDepoimentos());
  } catch (err) {
    console.error('Erro ao listar depoimentos (admin):', err);
    res.status(500).json({ error: 'Erro ao carregar os depoimentos.' });
  }
});

// Substitui a lista inteira (a tela edita tudo de uma vez: adicionar, editar, ordenar, remover).
router.put('/super-admin/depoimentos', validate(depoimentosSchema), async (req, res) => {
  const lista = req.body.depoimentos.map((d) => ({ ...d, id: d.id || crypto.randomUUID() }));
  const { error } = await supabase
    .from('plataforma_configuracoes')
    .upsert({ chave: CHAVE, valor: JSON.stringify(lista), atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
  if (error) {
    console.error('Erro ao salvar depoimentos:', error);
    return res.status(500).json({ error: 'Erro ao salvar os depoimentos.' });
  }
  res.json({ message: 'Depoimentos salvos.', depoimentos: lista });
});

module.exports = router;
