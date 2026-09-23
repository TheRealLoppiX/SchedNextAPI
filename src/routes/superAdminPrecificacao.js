const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { campanhaPrecificacaoSchema, campanhaAtivaSchema } = require('../schemas');

const router = express.Router();

// --- Campanhas promocionais de preço escalonado por ciclo (ex: Black Friday) do plano da
// PLATAFORMA — ver sql/2026_campanhas_precificacao.sql e services/precificacaoPlataforma.js
// (onde o preço de cada ciclo é de fato resolvido, no cadastro/upgrade e nas renovações).

router.get('/super-admin/campanhas-precificacao', async (req, res) => {
  const { data, error } = await supabase
    .from('campanhas_precificacao')
    .select('id, nome, ativa, inicio, fim, criado_em, plano_plataforma:plano_plataforma_id(id, nome, preco_mensal), campanha_precos_ciclo(numero_ciclo, valor)')
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erro ao buscar campanhas.' });
  res.json((data || []).map((c) => ({
    ...c,
    campanha_precos_ciclo: (c.campanha_precos_ciclo || []).sort((a, b) => a.numero_ciclo - b.numero_ciclo)
  })));
});

router.post('/super-admin/campanhas-precificacao', validate(campanhaPrecificacaoSchema), async (req, res) => {
  const { plano_plataforma_id, nome, inicio, fim, precos_por_ciclo } = req.body;

  const { data: plano } = await supabase.from('planos_plataforma').select('id').eq('id', plano_plataforma_id).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  const { data: campanha, error } = await supabase
    .from('campanhas_precificacao')
    .insert({ plano_plataforma_id, nome, inicio, fim })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao criar campanha.' });

  const { error: errPrecos } = await supabase.from('campanha_precos_ciclo').insert(
    precos_por_ciclo.map((p) => ({ campanha_id: campanha.id, numero_ciclo: p.numero_ciclo, valor: p.valor }))
  );
  if (errPrecos) {
    // Sem a tabela de preços, a campanha fica inútil (precoDoCiclo sempre cai no preço cheio) —
    // desfaz a criação em vez de deixar uma campanha "quebrada" pra trás.
    await supabase.from('campanhas_precificacao').delete().eq('id', campanha.id);
    return res.status(500).json({ error: 'Erro ao salvar os preços por ciclo.' });
  }

  res.status(201).json({ success: true, id: campanha.id, message: 'Campanha criada.' });
});

router.put('/super-admin/campanhas-precificacao/:id', validate(campanhaPrecificacaoSchema), async (req, res) => {
  const { plano_plataforma_id, nome, inicio, fim, precos_por_ciclo } = req.body;

  const { data: plano } = await supabase.from('planos_plataforma').select('id').eq('id', plano_plataforma_id).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  const { error } = await supabase
    .from('campanhas_precificacao')
    .update({ plano_plataforma_id, nome, inicio, fim })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar campanha.' });

  // Substitui a lista inteira de preços por ciclo em vez de tentar diff — mais simples e o
  // formulário do admin absoluto sempre manda a lista completa mesmo.
  await supabase.from('campanha_precos_ciclo').delete().eq('campanha_id', req.params.id);
  const { error: errPrecos } = await supabase.from('campanha_precos_ciclo').insert(
    precos_por_ciclo.map((p) => ({ campanha_id: req.params.id, numero_ciclo: p.numero_ciclo, valor: p.valor }))
  );
  if (errPrecos) return res.status(500).json({ error: 'Campanha atualizada, mas houve erro ao salvar os preços por ciclo.' });

  res.json({ success: true, message: 'Campanha atualizada.' });
});

router.put('/super-admin/campanhas-precificacao/:id/ativa', validate(campanhaAtivaSchema), async (req, res) => {
  const { error } = await supabase.from('campanhas_precificacao').update({ ativa: req.body.ativa }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar campanha.' });
  res.json({
    success: true,
    // Desligar é o kill-switch geral: quem já entrou na campanha cai no preço cheio a partir do
    // próximo ciclo (ver precoDoCiclo em services/precificacaoPlataforma.js), sem precisar
    // excluir nada.
    message: req.body.ativa ? 'Campanha ativada.' : 'Campanha desativada. Quem já estava nela cai no preço cheio a partir do próximo ciclo.'
  });
});

router.delete('/super-admin/campanhas-precificacao/:id', async (req, res) => {
  const { error } = await supabase.from('campanhas_precificacao').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir campanha.' });
  res.json({ success: true, message: 'Campanha excluída.' });
});

module.exports = router;
