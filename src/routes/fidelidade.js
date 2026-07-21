const express = require('express');
const supabase = require('../config/supabase');

const router = express.Router();

router.get('/admin/acoes/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('campanhas_fidelidade')
    .select('*')
    .eq('empresa_id', req.params.empresaId)
    .order('data_fim', { ascending: false });

  if (error) return res.status(500).json(error);
  res.json(data);
});

router.post('/admin/acoes', async (req, res) => {
  const { empresa_id, nome, data_inicio, data_fim, cortes_necessarios, valor_minimo, premio_descritivo, tipo_premio } = req.body;

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

router.put('/admin/acoes/:id/status', async (req, res) => {
  const { id } = req.params;
  const { empresa_id, ativar } = req.body;

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
  const { error } = await supabase.from('campanhas_fidelidade').delete().eq('id', req.params.id);
  if (error) return res.status(500).json(error);
  res.json({ message: 'Ação excluída!' });
});

module.exports = router;
