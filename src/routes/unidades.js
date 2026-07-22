const express = require('express');
const supabase = require('../config/supabase');
const { permiteMultiUnidade } = require('../utils/limitesPlano');
const { obterSlugTenant, resolverEmpresaPorSlug } = require('../utils/tenantContext');
const validate = require('../middleware/validate');
const { unidadeCriarSchema, unidadeAtualizarSchema } = require('../schemas');

const router = express.Router();

// Pública, usada pelo fluxo de agendamento do cliente pra decidir se mostra um seletor
// de unidade (só faz sentido perguntar quando existe mais de uma unidade ativa).
router.get('/unidades', async (req, res) => {
  const slug = obterSlugTenant(req);
  const { empresa: emp } = await resolverEmpresaPorSlug(slug, 'id');
  if (!emp) return res.json([]);

  const { data, error } = await supabase
    .from('unidades')
    .select('id, nome, endereco')
    .eq('empresa_id', emp.id)
    .eq('ativo', true)
    .order('id');

  if (error) return res.json([]);
  res.json(data);
});

// Multi-unidade é um recurso exclusivo do plano Enterprise (ver §3 do plano de plataforma).
// Diferente dos limites de profissionais/agendamentos, aqui não existe "primeira unidade
// grátis": o recurso inteiro só existe pra quem tem o plano certo. Empresas sem esse plano
// continuam funcionando exatamente como sempre funcionaram (barbeiros/agendamentos sem
// unidade_id, ou seja, uma única localização implícita).

router.get('/admin/unidades/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('unidades')
    .select('*')
    .eq('empresa_id', req.empresaId)
    .order('id');

  if (error) return res.status(500).json({ error: 'Erro ao listar unidades.' });
  res.json(data);
});

router.post('/admin/unidades', validate(unidadeCriarSchema), async (req, res) => {
  const { nome, endereco } = req.body;
  const empresa_id = req.empresaId;

  if (!(await permiteMultiUnidade(empresa_id))) {
    return res.status(403).json({ error: 'Multi-unidade é um recurso exclusivo do plano Enterprise. Faça upgrade para cadastrar mais de uma localização.' });
  }

  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome da unidade é obrigatório.' });

  const { data, error } = await supabase
    .from('unidades')
    .insert({ empresa_id, nome: nome.trim(), endereco: endereco || null })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao criar unidade.' });
  res.status(201).json(data);
});

router.put('/admin/unidades/:id', validate(unidadeAtualizarSchema), async (req, res) => {
  const { nome, endereco, horarios_funcionamento, ativo } = req.body;

  const { data: unidade } = await supabase.from('unidades').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!unidade || unidade.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Unidade não encontrada.' });

  if (!(await permiteMultiUnidade(unidade.empresa_id))) {
    return res.status(403).json({ error: 'Multi-unidade é um recurso exclusivo do plano Enterprise.' });
  }

  const atualizacao = {};
  if (nome !== undefined) atualizacao.nome = nome;
  if (endereco !== undefined) atualizacao.endereco = endereco;
  if (horarios_funcionamento !== undefined) atualizacao.horarios_funcionamento = JSON.stringify(horarios_funcionamento);
  if (ativo !== undefined) atualizacao.ativo = ativo;

  const { error } = await supabase.from('unidades').update(atualizacao).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar unidade.' });
  res.json({ success: true });
});

router.delete('/admin/unidades/:id', async (req, res) => {
  const { data: unidade } = await supabase.from('unidades').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!unidade || unidade.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Unidade não encontrada.' });

  // Barbeiros/agendamentos vinculados só perdem a referência (unidade_id vira null, ver
  // ON DELETE SET NULL na migração), nunca são apagados junto.
  const { error } = await supabase.from('unidades').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir unidade.' });
  res.json({ success: true });
});

module.exports = router;
