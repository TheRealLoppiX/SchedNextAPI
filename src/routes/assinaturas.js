const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { assinaturaPlanoSchema, ativoSchema, clientePlanoSchema } = require('../schemas');

const router = express.Router();

// Listar planos com servicos e total de assinantes
router.get('/admin/assinaturas/:empresaId', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: planos, error } = await supabase
    .from('planos_assinatura')
    .select('id, nome, preco, descricao, ativo, criado_em, plano_servicos(servicos(id, nome), limite_mensal)')
    .eq('empresa_id', empresaId)
    .order('criado_em', { ascending: false });

  if (error) { console.error('Erro assinaturas:', error); return res.status(500).json([]); }

  const planoIds = planos.map((p) => p.id);
  let contagemPorPlano = {};

  if (planoIds.length > 0) {
    const { data: assinantes, error: errAss } = await supabase
      .from('usuarios')
      .select('plano_id')
      .in('plano_id', planoIds)
      .eq('assinante', true);

    if (errAss) { console.error('Erro assinaturas:', errAss); return res.status(500).json([]); }

    contagemPorPlano = assinantes.reduce((acc, u) => {
      acc[u.plano_id] = (acc[u.plano_id] || 0) + 1;
      return acc;
    }, {});
  }

  const formatado = planos.map((p) => {
    const servicosUnicos = [...new Map(
      (p.plano_servicos || [])
        .filter((ps) => ps.servicos)
        .map((ps) => [ps.servicos.id, { ...ps.servicos, limite_mensal: ps.limite_mensal }])
    ).values()].sort((a, b) => a.nome.localeCompare(b.nome));

    return {
      id: p.id,
      nome: p.nome,
      preco: p.preco,
      descricao: p.descricao,
      ativo: p.ativo,
      criado_em: p.criado_em,
      servicos_nomes: servicosUnicos.map((s) => s.nome).join(', ') || null,
      servicos_ids: servicosUnicos.map((s) => s.id),
      servicos: servicosUnicos.map((s) => ({ id: s.id, nome: s.nome, limite_mensal: s.limite_mensal })),
      total_assinantes: contagemPorPlano[p.id] || 0
    };
  });

  res.json(formatado);
});

// Pública de propósito: usada pelo badge de assinante no Layout.js do cliente (não tem token
// de admin disponível ali). Só devolve nome/preço de um plano, nada sensível.
router.get('/assinaturas/plano/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('planos_assinatura')
    .select('id, nome, preco')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({});
  res.json(data);
});

// Criar plano
router.post('/admin/assinaturas', validate(assinaturaPlanoSchema), async (req, res) => {
  const { nome, preco, descricao, servicos } = req.body;
  const empresa_id = req.empresaId;

  try {
    const { data: plano, error } = await supabase
      .from('planos_assinatura')
      .insert({ empresa_id, nome, preco, descricao: descricao || null })
      .select('id')
      .single();

    if (error) throw error;

    if (servicos && servicos.length > 0) {
      const rows = servicos.map((s) => ({ plano_id: plano.id, servico_id: s.id, limite_mensal: s.limite_mensal ?? null }));
      const { error: errServicos } = await supabase.from('plano_servicos').insert(rows);
      if (errServicos) throw errServicos;
    }

    res.json({ success: true, id: plano.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar plano
router.put('/admin/assinaturas/:id', validate(assinaturaPlanoSchema), async (req, res) => {
  const { id } = req.params;
  const { nome, preco, descricao, servicos } = req.body;

  try {
    const { data: planoAtual } = await supabase.from('planos_assinatura').select('empresa_id').eq('id', id).maybeSingle();
    if (!planoAtual || planoAtual.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Plano não encontrado.' });

    const { error } = await supabase
      .from('planos_assinatura')
      .update({ nome, preco, descricao: descricao || null })
      .eq('id', id);
    if (error) throw error;

    const { error: errDel } = await supabase.from('plano_servicos').delete().eq('plano_id', id);
    if (errDel) throw errDel;

    if (servicos && servicos.length > 0) {
      const rows = servicos.map((s) => ({ plano_id: Number(id), servico_id: s.id, limite_mensal: s.limite_mensal ?? null }));
      const { error: errIns } = await supabase.from('plano_servicos').insert(rows);
      if (errIns) throw errIns;
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Ativar/desativar plano
router.put('/admin/assinaturas/:id/status', validate(ativoSchema), async (req, res) => {
  const { ativo } = req.body;

  const { data: planoAtual } = await supabase.from('planos_assinatura').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!planoAtual || planoAtual.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Plano não encontrado.' });

  const { error } = await supabase.from('planos_assinatura').update({ ativo: !!ativo }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Excluir plano
router.delete('/admin/assinaturas/:id', async (req, res) => {
  const { data: planoAtual } = await supabase.from('planos_assinatura').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!planoAtual || planoAtual.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Plano não encontrado.' });

  const { error } = await supabase.from('planos_assinatura').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Vincular cliente a um plano
router.put('/admin/clientes/:id/plano', validate(clientePlanoSchema), async (req, res) => {
  const { plano_id } = req.body;
  const empresa_id = req.empresaId;

  const { data: cliente } = await supabase.from('usuarios').select('empresa_id, assinante, assinante_desde').eq('id', req.params.id).maybeSingle();
  if (!cliente || cliente.empresa_id !== empresa_id) return res.status(404).json({ error: 'Cliente não encontrado.' });

  if (plano_id) {
    const { data: plano } = await supabase.from('planos_assinatura').select('empresa_id').eq('id', plano_id).maybeSingle();
    if (!plano || plano.empresa_id !== empresa_id) return res.status(404).json({ error: 'Plano não encontrado.' });
  }

  // assinante_desde ancora o ciclo rolante de uso mensal (ver utils/limitesAssinatura.js).
  // Só seta na primeira ativação: trocar de plano com o cliente já assinante não deve
  // resetar o ciclo/consumo em andamento.
  const update = plano_id
    ? { plano_id, assinante: true, ...((!cliente.assinante || !cliente.assinante_desde) && { assinante_desde: new Date().toISOString().split('T')[0] }) }
    : { plano_id: null, assinante: false };

  const { error } = await supabase.from('usuarios').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
