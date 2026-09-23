const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { campanhaAssinaturaSchema, campanhaAtivaSchema } = require('../schemas');
const { permiteCampanhasAssinatura } = require('../utils/limitesPlano');

const router = express.Router();

// Campanhas promocionais de preço escalonado por ciclo da assinatura de CLIENTE FINAL — cada
// empresa cria e gerencia as próprias, sempre escopadas por req.empresaId (nunca por :id de
// outra empresa, mesmo padrão de ownership de routes/assinaturas.js). Feature de plano: só quem
// tem permite_campanhas_assinatura consegue criar/editar (ver utils/limitesPlano.js) — listar
// fica liberado pra empresa ver campanhas que já tinha antes de um downgrade de plano, mesmo sem
// poder criar novas.

router.get('/admin/campanhas-assinatura', async (req, res) => {
  const { data, error } = await supabase
    .from('campanhas_assinatura')
    .select('id, nome, ativa, inicio, fim, criado_em, plano_assinatura:plano_assinatura_id(id, nome, preco), campanha_assinatura_precos_ciclo(numero_ciclo, valor)')
    .eq('empresa_id', req.empresaId)
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erro ao buscar campanhas.' });
  res.json((data || []).map((c) => ({
    ...c,
    campanha_assinatura_precos_ciclo: (c.campanha_assinatura_precos_ciclo || []).sort((a, b) => a.numero_ciclo - b.numero_ciclo)
  })));
});

router.post('/admin/campanhas-assinatura', validate(campanhaAssinaturaSchema), async (req, res) => {
  if (!(await permiteCampanhasAssinatura(req.empresaId))) {
    return res.status(403).json({ error: 'Seu plano não inclui campanhas promocionais de assinatura. Fale com o suporte para fazer upgrade.' });
  }

  const { plano_assinatura_id, nome, inicio, fim, precos_por_ciclo } = req.body;

  const { data: plano } = await supabase.from('planos_assinatura').select('id').eq('id', plano_assinatura_id).eq('empresa_id', req.empresaId).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  const { data: campanha, error } = await supabase
    .from('campanhas_assinatura')
    .insert({ empresa_id: req.empresaId, plano_assinatura_id, nome, inicio, fim })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: 'Erro ao criar campanha.' });

  const { error: errPrecos } = await supabase.from('campanha_assinatura_precos_ciclo').insert(
    precos_por_ciclo.map((p) => ({ campanha_id: campanha.id, numero_ciclo: p.numero_ciclo, valor: p.valor }))
  );
  if (errPrecos) {
    await supabase.from('campanhas_assinatura').delete().eq('id', campanha.id);
    return res.status(500).json({ error: 'Erro ao salvar os preços por ciclo.' });
  }

  res.status(201).json({ success: true, id: campanha.id, message: 'Campanha criada.' });
});

router.put('/admin/campanhas-assinatura/:id', validate(campanhaAssinaturaSchema), async (req, res) => {
  if (!(await permiteCampanhasAssinatura(req.empresaId))) {
    return res.status(403).json({ error: 'Seu plano não inclui campanhas promocionais de assinatura. Fale com o suporte para fazer upgrade.' });
  }

  const { data: atual } = await supabase.from('campanhas_assinatura').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!atual || atual.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Campanha não encontrada.' });

  const { plano_assinatura_id, nome, inicio, fim, precos_por_ciclo } = req.body;
  const { data: plano } = await supabase.from('planos_assinatura').select('id').eq('id', plano_assinatura_id).eq('empresa_id', req.empresaId).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  const { error } = await supabase
    .from('campanhas_assinatura')
    .update({ plano_assinatura_id, nome, inicio, fim })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar campanha.' });

  await supabase.from('campanha_assinatura_precos_ciclo').delete().eq('campanha_id', req.params.id);
  const { error: errPrecos } = await supabase.from('campanha_assinatura_precos_ciclo').insert(
    precos_por_ciclo.map((p) => ({ campanha_id: req.params.id, numero_ciclo: p.numero_ciclo, valor: p.valor }))
  );
  if (errPrecos) return res.status(500).json({ error: 'Campanha atualizada, mas houve erro ao salvar os preços por ciclo.' });

  res.json({ success: true, message: 'Campanha atualizada.' });
});

router.put('/admin/campanhas-assinatura/:id/ativa', validate(campanhaAtivaSchema), async (req, res) => {
  const { data: atual } = await supabase.from('campanhas_assinatura').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!atual || atual.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Campanha não encontrada.' });

  const { error } = await supabase.from('campanhas_assinatura').update({ ativa: req.body.ativa }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar campanha.' });
  res.json({
    success: true,
    message: req.body.ativa ? 'Campanha ativada.' : 'Campanha desativada. Quem já estava nela cai no preço cheio a partir do próximo ciclo.'
  });
});

router.delete('/admin/campanhas-assinatura/:id', async (req, res) => {
  const { data: atual } = await supabase.from('campanhas_assinatura').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!atual || atual.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Campanha não encontrada.' });

  const { error } = await supabase.from('campanhas_assinatura').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir campanha.' });
  res.json({ success: true, message: 'Campanha excluída.' });
});

module.exports = router;
