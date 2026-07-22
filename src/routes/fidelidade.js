const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { acaoFidelidadeSchema, acaoStatusSchema } = require('../schemas');

const router = express.Router();

router.get('/admin/acoes/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('campanhas_fidelidade')
    .select('*')
    .eq('empresa_id', req.empresaId)
    .order('data_fim', { ascending: false });

  if (error) return res.status(500).json(error);
  res.json(data);
});

router.post('/admin/acoes', validate(acaoFidelidadeSchema), async (req, res) => {
  const { nome, data_inicio, data_fim, cortes_necessarios, valor_minimo, premio_descritivo, tipo_premio } = req.body;
  const empresa_id = req.empresaId;

  // Desativa as outras para garantir que só 1 fique ativa por vez ao criar uma nova
  await supabase.from('campanhas_fidelidade').update({ ativa: false }).eq('empresa_id', empresa_id);

  const { error } = await supabase.from('campanhas_fidelidade').insert({
    empresa_id,
    nome,
    data_inicio,
    data_fim,
    cortes_necessarios,
    valor_minimo,
    premio_descritivo,
    tipo_premio: tipo_premio || 'servico',
    ativa: true
  });

  if (error) return res.status(500).json(error);
  res.json({ message: 'Ação criada e ativada com sucesso!' });
});

router.put('/admin/acoes/:id/status', validate(acaoStatusSchema), async (req, res) => {
  const { id } = req.params;
  const { ativar } = req.body;
  const empresa_id = req.empresaId;

  const { data: campanha } = await supabase.from('campanhas_fidelidade').select('empresa_id').eq('id', id).maybeSingle();
  if (!campanha || campanha.empresa_id !== empresa_id) return res.status(404).json({ error: 'Ação não encontrada.' });

  if (ativar) {
    // Se for ativar, desativa todas as outras primeiro
    await supabase.from('campanhas_fidelidade').update({ ativa: false }).eq('empresa_id', empresa_id);
    await supabase.from('campanhas_fidelidade').update({ ativa: true }).eq('id', id);
    return res.json({ message: 'Ativada!' });
  }

  await supabase.from('campanhas_fidelidade').update({ ativa: false }).eq('id', id);
  res.json({ message: 'Desativada!' });
});

router.delete('/admin/acoes/:id', async (req, res) => {
  const { data: campanha } = await supabase.from('campanhas_fidelidade').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!campanha || campanha.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Ação não encontrada.' });

  const { error } = await supabase.from('campanhas_fidelidade').delete().eq('id', req.params.id);
  if (error) return res.status(500).json(error);
  res.json({ message: 'Ação excluída!' });
});

module.exports = router;
