const express = require('express');
const supabase = require('../config/supabase');
const { obterSlugTenant, resolverEmpresaPorSlug } = require('../utils/tenantContext');
const { limiteProfissionaisAtingido, confirmarLimiteProfissionaisOuDesfazer } = require('../utils/limitesPlano');
const validate = require('../middleware/validate');
const {
  barbeiroCriarSchema,
  barbeiroEditarSchema,
  barbeiroStatusSchema,
  bloqueioSchema,
  barbeiroServicosSchema
} = require('../schemas');

const router = express.Router();

router.get('/barbeiros', async (req, res) => {
  const slug = obterSlugTenant(req);
  const { empresa: emp, error: empErr } = await resolverEmpresaPorSlug(slug, 'id, nome, horarios_funcionamento');

  if (empErr || !emp) return res.status(500).json([]);

  let query = supabase.from('barbeiros').select('*').eq('empresa_id', emp.id);
  if (req.query.unidade_id) query = query.eq('unidade_id', req.query.unidade_id);

  const { data: barbeiros, error } = await query;
  if (error) return res.status(500).json([]);

  const ids = barbeiros.map((b) => b.id);
  let avaliacoesPorBarbeiro = {};
  if (ids.length > 0) {
    const { data: avals } = await supabase.from('avaliacoes').select('barbeiro_id, nota').in('barbeiro_id', ids);
    for (const av of avals || []) {
      if (!avaliacoesPorBarbeiro[av.barbeiro_id]) avaliacoesPorBarbeiro[av.barbeiro_id] = [];
      avaliacoesPorBarbeiro[av.barbeiro_id].push(av.nota);
    }
  }

  const resultado = barbeiros.map((b) => {
    const notas = avaliacoesPorBarbeiro[b.id] || [];
    const media = notas.length > 0 ? notas.reduce((a, n) => a + n, 0) / notas.length : 0;
    return {
      ...b,
      nome_empresa: emp.nome,
      horarios_funcionamento: emp.horarios_funcionamento,
      media_estrelas: media,
      total_avaliacoes: notas.length
    };
  });

  res.json(resultado);
});

// Só usadas por AdminBarbeiros.js. Vivem sob /admin/* de propósito (verificarTokenAdmin já
// garante req.empresaId), diferente da versão antiga que era pública ("/barbeiro-servicos"
// sem prefixo), quando qualquer chamador anônimo podia reescrever os serviços de um barbeiro
// de qualquer empresa só sabendo o ID.
router.get('/admin/barbeiro-servicos/:barbeiro_id', async (req, res) => {
  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', req.params.barbeiro_id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  const { data, error } = await supabase
    .from('barbeiro_servicos')
    .select('servico_id')
    .eq('barbeiro_id', req.params.barbeiro_id);

  if (error) return res.status(500).json(error);
  res.json(data.map((r) => r.servico_id));
});

// Salvar/Atualizar serviços do barbeiro
router.post('/admin/barbeiro-servicos', validate(barbeiroServicosSchema), async (req, res) => {
  const { barbeiro_id, servicosIds } = req.body;

  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', barbeiro_id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  const { error: delError } = await supabase.from('barbeiro_servicos').delete().eq('barbeiro_id', barbeiro_id);
  if (delError) return res.status(500).json(delError);

  if (servicosIds.length === 0) return res.json({ message: 'Serviços removidos' });

  const rows = servicosIds.map((servico_id) => ({ barbeiro_id, servico_id }));
  const { error } = await supabase.from('barbeiro_servicos').insert(rows);
  if (error) return res.status(500).json(error);
  res.json({ message: 'Serviços atualizados com sucesso!' });
});

// Listar equipe completa para o Admin
router.get('/admin/equipe/:empresaId', async (req, res) => {
  const { data, error } = await supabase.from('barbeiros').select('*').eq('empresa_id', req.empresaId);
  if (error) return res.status(500).json(error);
  res.json(data);
});

router.put('/admin/barbeiro/status', validate(barbeiroStatusSchema), async (req, res) => {
  const { id, ativo } = req.body;

  const { data, error } = await supabase
    .from('barbeiros')
    .update({ ativo: !!ativo })
    .eq('id', id)
    .eq('empresa_id', req.empresaId)
    .select('id');

  if (error) {
    console.error('Erro ao mudar status:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
  if (!data || data.length === 0) return res.status(404).json({ error: 'Barbeiro não encontrado.' });
  res.json({ message: 'Status alterado!' });
});

// Cadastrar novo barbeiro
router.post('/admin/barbeiro', validate(barbeiroCriarSchema), async (req, res) => {
  const { nome, foto_url, unidade_id } = req.body;
  const empresa_id = req.empresaId;

  if (await limiteProfissionaisAtingido(empresa_id)) {
    return res.status(403).json({ error: 'Você atingiu o limite de profissionais do seu plano atual. Faça upgrade para cadastrar mais.' });
  }

  const { data, error } = await supabase
    .from('barbeiros')
    .insert({ nome, empresa_id, foto_url, ativo: true, unidade_id: unidade_id || null })
    .select('id')
    .single();

  if (error) return res.status(500).json(error);

  if (!(await confirmarLimiteProfissionaisOuDesfazer(empresa_id, data.id))) {
    return res.status(403).json({ error: 'Você atingiu o limite de profissionais do seu plano atual. Faça upgrade para cadastrar mais.' });
  }

  res.json({ id: data.id });
});

router.put('/admin/barbeiro/editar', validate(barbeiroEditarSchema), async (req, res) => {
  const { id, nome, foto_url, percentual_comissao } = req.body;
  const atualizacao = { nome, foto_url };
  if (percentual_comissao !== undefined) atualizacao.percentual_comissao = percentual_comissao;

  const { data, error } = await supabase
    .from('barbeiros')
    .update(atualizacao)
    .eq('id', id)
    .eq('empresa_id', req.empresaId)
    .select('id');

  if (error) return res.status(500).json(error);
  if (!data || data.length === 0) return res.status(404).json({ error: 'Barbeiro não encontrado.' });
  res.json({ success: true });
});

router.delete('/admin/barbeiro/:id', async (req, res) => {
  const { id } = req.params;

  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  // Limpamos os vínculos e bloqueios primeiro para evitar erro no banco
  await supabase.from('barbeiro_servicos').delete().eq('barbeiro_id', id);
  await supabase.from('bloqueios').delete().eq('barbeiro_id', id);

  const { error } = await supabase.from('barbeiros').delete().eq('id', id);
  if (error) {
    // Proteção: se ele já cortou cabelo de alguém, o banco não deixa apagar para não quebrar o histórico financeiro
    if (error.code === '23503') {
      return res.status(400).json({ error: 'Este barbeiro possui agendamentos no histórico. É recomendado desativá-lo em vez de excluí-lo.' });
    }
    return res.status(500).json({ error: 'Erro ao excluir barbeiro.' });
  }
  res.json({ message: 'Barbeiro removido com sucesso!' });
});

// --- BLOQUEIOS ---

// 1. SALVAR BLOQUEIO (Admin)
router.post('/admin/bloqueio', validate(bloqueioSchema), async (req, res) => {
  const { barbeiro_id, data_bloqueio, data_fim, hora_inicio, hora_fim, motivo } = req.body;

  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', barbeiro_id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  // Fallback: se não houver data_fim, o bloqueio é de apenas um dia
  const finalDate = data_fim || data_bloqueio;

  const { error } = await supabase
    .from('bloqueios')
    .insert({ barbeiro_id, data_bloqueio, data_fim: finalDate, hora_inicio, hora_fim, motivo });

  if (error) {
    console.error('Erro ao inserir bloqueio:', error);
    return res.status(500).json(error);
  }
  res.json({ success: true });
});

// 2. LISTAR BLOQUEIOS (Usado pelo AdminBarbeiros para exibir os cards)
router.get('/admin/bloqueios/:barbeiro_id', async (req, res) => {
  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', req.params.barbeiro_id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  const hoje = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('bloqueios')
    .select('id, barbeiro_id, data_bloqueio, data_fim, hora_inicio, hora_fim, motivo')
    .eq('barbeiro_id', req.params.barbeiro_id)
    .or(`data_fim.gte.${hoje},data_fim.is.null`)
    .order('data_bloqueio', { ascending: true })
    .order('hora_inicio', { ascending: true });

  if (error) {
    console.error('Erro no banco:', error);
    return res.status(500).json(error);
  }
  res.json(data);
});

// 3. DELETAR BLOQUEIO (Admin)
router.delete('/admin/bloqueio/:id', async (req, res) => {
  const { data: bloqueio } = await supabase.from('bloqueios').select('id, barbeiro_id').eq('id', req.params.id).maybeSingle();
  if (!bloqueio) return res.status(404).json({ message: 'Não encontrado' });

  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', bloqueio.barbeiro_id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== req.empresaId) return res.status(404).json({ message: 'Não encontrado' });

  const { data, error } = await supabase.from('bloqueios').delete().eq('id', req.params.id).select('id');
  if (error) return res.status(500).json(error);
  if (!data || data.length === 0) return res.status(404).json({ message: 'Não encontrado' });
  res.json({ success: true });
});

// --- AGENDA/STATUS ---

router.get('/admin/agenda-barbeiro/:barbeiro_id', async (req, res) => {
  const { barbeiro_id } = req.params;
  const { data: dataQuery } = req.query; // Pega a data enviada (?data=2026-02-17)

  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', barbeiro_id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

  const { data: agendamentos, error } = await supabase
    .from('agendamentos')
    .select('id, data_hora, status, usuarios(nome_completo, telefone), agendamento_servicos(servicos(nome))')
    .eq('barbeiro_id', barbeiro_id)
    .gte('data_hora', `${dataQuery}T00:00:00`)
    .lte('data_hora', `${dataQuery}T23:59:59`)
    .neq('status', 'cancelado')
    .order('data_hora', { ascending: true });

  if (error) return res.status(500).json(error);

  const resultado = agendamentos.map((a) => ({
    id: a.id,
    hora: new Date(a.data_hora).toISOString().slice(11, 16),
    status: a.status,
    nome_cliente: a.usuarios ? a.usuarios.nome_completo : null,
    telefone_cliente: a.usuarios ? a.usuarios.telefone : null,
    servicos: (a.agendamento_servicos || []).map((as) => as.servicos && as.servicos.nome).filter(Boolean).join(' + ')
  }));

  res.json(resultado);
});

router.get('/admin/barbeiros-status/:empresa_id', async (req, res) => {
  const empresa_id = req.empresaId;
  const { dataInicio, dataFim } = req.query;

  const { data: barbeiros, error: barbErr } = await supabase
    .from('barbeiros')
    .select('id, nome, foto_url')
    .eq('empresa_id', empresa_id);

  if (barbErr) return res.status(500).json([]);

  const ids = barbeiros.map((b) => b.id);
  let agendamentosQuery = supabase
    .from('agendamentos')
    .select('id, barbeiro_id')
    .in('barbeiro_id', ids)
    .not('status', 'in', '(cancelado,concluido)');

  if (dataInicio) agendamentosQuery = agendamentosQuery.gte('data_hora', `${dataInicio}T00:00:00`);
  if (dataFim) agendamentosQuery = agendamentosQuery.lte('data_hora', `${dataFim}T23:59:59`);

  const { data: agendamentos, error: agErr } = await agendamentosQuery;
  if (agErr) return res.status(500).json([]);

  const { data: avaliacoes } = await supabase.from('avaliacoes').select('barbeiro_id, nota').in('barbeiro_id', ids);

  const cortesPorBarbeiro = {};
  for (const a of agendamentos || []) {
    cortesPorBarbeiro[a.barbeiro_id] = (cortesPorBarbeiro[a.barbeiro_id] || 0) + 1;
  }

  const notasPorBarbeiro = {};
  for (const av of avaliacoes || []) {
    if (!notasPorBarbeiro[av.barbeiro_id]) notasPorBarbeiro[av.barbeiro_id] = [];
    notasPorBarbeiro[av.barbeiro_id].push(av.nota);
  }

  const resultado = barbeiros.map((b) => {
    const notas = notasPorBarbeiro[b.id] || [];
    const media = notas.length > 0 ? notas.reduce((a, n) => a + n, 0) / notas.length : 0;
    return {
      id: b.id,
      nome: b.nome,
      foto_url: b.foto_url,
      cortes_agendados: cortesPorBarbeiro[b.id] || 0,
      media_estrelas: media
    };
  });

  res.json(resultado);
});

module.exports = router;
