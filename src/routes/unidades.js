const express = require('express');
const bcrypt = require('bcrypt');
const supabase = require('../config/supabase');
const { permiteMultiUnidade } = require('../utils/limitesPlano');
const { obterSlugTenant, resolverEmpresaPorSlug } = require('../utils/tenantContext');
const validate = require('../middleware/validate');
const { unidadeCriarSchema, unidadeAtualizarSchema, unidadeAdminCriarSchema, ativoSchema } = require('../schemas');

const router = express.Router();

// Admin de uma unidade só (req.unidadeId, ver middleware/adminAuth.js) sempre usa a própria
// unidade; admin de empresa escolhe via ?unidade_id= (obrigatório nesse caso, pra ver a
// dashboard de uma unidade específica).
function resolverUnidadeId(req) {
  if (req.unidadeId) return req.unidadeId;
  const q = req.query.unidade_id;
  return q ? Number(q) : null;
}

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

// --- Dashboard da unidade (admin de empresa ou admin da própria unidade, ver
// server.js/ROTAS_PERMITIDAS_ADMIN_UNIDADE) — só o operacional: agenda, equipe, estatísticas
// básicas. Assinatura da plataforma, domínio, WhatsApp, Mercado Pago e API continuam exclusivos
// do admin de empresa (nem estão na allowlist).

router.get('/admin/unidade/minhas', async (req, res) => {
  if (req.unidadeId) {
    const { data, error } = await supabase.from('unidades').select('id, nome, endereco').eq('id', req.unidadeId).maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'Unidade não encontrada.' });
    return res.json([data]);
  }

  const { data, error } = await supabase
    .from('unidades')
    .select('id, nome, endereco')
    .eq('empresa_id', req.empresaId)
    .eq('ativo', true)
    .order('id');

  if (error) return res.status(500).json({ error: 'Erro ao listar unidades.' });
  res.json(data || []);
});

router.get('/admin/unidade/dashboard', async (req, res) => {
  const unidadeId = resolverUnidadeId(req);
  if (!unidadeId) return res.status(400).json({ error: 'Escolha uma unidade.' });

  const { data: unidade } = await supabase.from('unidades').select('empresa_id').eq('id', unidadeId).maybeSingle();
  if (!unidade || unidade.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Unidade não encontrada.' });

  // Mesma lógica de GET /admin/stats/:empresa_id (agendamentos.js), só que filtrada por
  // unidade em vez de empresa inteira. novos_clientes fica de fora — cliente é da empresa
  // inteira, não tem unidade_id, não faz sentido contar "por unidade".
  const { dataInicio, dataFim } = req.query;
  let query = supabase.from('agendamentos').select('id, status, data_hora').eq('unidade_id', unidadeId);
  if (dataInicio) query = query.gte('data_hora', `${dataInicio}T00:00:00`);
  if (dataFim) query = query.lte('data_hora', `${dataFim}T23:59:59`);

  const { data: agendamentos, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar estatísticas.' });

  const agora = new Date();
  const dezMinAtras = new Date(agora.getTime() - 10 * 60000);

  const total = agendamentos.length;
  const concluidos = agendamentos.filter((a) => a.status === 'concluido').length;
  const cancelados = agendamentos.filter((a) => a.status === 'cancelado').length;
  const nao_compareceu = agendamentos.filter(
    (a) => a.status !== 'cancelado' && a.status !== 'concluido' && new Date(a.data_hora) < dezMinAtras
  ).length;

  res.json({
    total,
    concluidos,
    cancelados,
    nao_compareceu,
    taxa_conclusao: total > 0 ? ((concluidos / total) * 100).toFixed(1) : 0,
    taxa_cancelamento: total > 0 ? ((cancelados / total) * 100).toFixed(1) : 0,
    taxa_nao_compareceu: total > 0 ? ((nao_compareceu / total) * 100).toFixed(1) : 0
  });
});

router.get('/admin/unidade/agendamentos', async (req, res) => {
  const unidadeId = resolverUnidadeId(req);
  if (!unidadeId) return res.status(400).json({ error: 'Escolha uma unidade.' });

  const { data: unidade } = await supabase.from('unidades').select('empresa_id').eq('id', unidadeId).maybeSingle();
  if (!unidade || unidade.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Unidade não encontrada.' });

  // Mesma lógica de GET /admin/agendamentos/:empresaId (agendamentos.js), filtrada por unidade.
  const { data, error } = await supabase
    .from('agendamentos')
    .select(
      'id, data_hora, status, valor_total, duracao_total, cliente_nome, usuarios(nome_completo, telefone), barbeiros(id, nome), agendamento_servicos(servicos(nome))'
    )
    .eq('unidade_id', unidadeId)
    .order('data_hora', { ascending: false });

  if (error) {
    console.error('Erro admin/unidade/agendamentos:', error);
    return res.status(500).json([]);
  }

  const formatado = data.map((row) => {
    const dh = new Date(row.data_hora);
    const nomesServicos = (row.agendamento_servicos || [])
      .map((as) => as.servicos && as.servicos.nome)
      .filter(Boolean)
      .join(' + ');

    return {
      id: row.id,
      data: dh.toISOString().slice(0, 10),
      hora: dh.toISOString().slice(11, 16),
      status: row.status,
      valor_total: row.valor_total,
      duracao: row.duracao_total,
      servico_nome: nomesServicos || 'Serviço',
      servicos: nomesServicos || 'Serviço',
      cliente_nome: (row.usuarios && row.usuarios.nome_completo) || row.cliente_nome || 'Cliente Avulso',
      cliente_telefone: (row.usuarios && row.usuarios.telefone) || '',
      barbeiro_nome: row.barbeiros ? row.barbeiros.nome : null,
      barbeiro_id: row.barbeiros ? row.barbeiros.id : null
    };
  });

  res.json(formatado);
});

router.get('/admin/unidade/equipe', async (req, res) => {
  const unidadeId = resolverUnidadeId(req);
  if (!unidadeId) return res.status(400).json({ error: 'Escolha uma unidade.' });

  const { data: unidade } = await supabase.from('unidades').select('empresa_id').eq('id', unidadeId).maybeSingle();
  if (!unidade || unidade.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Unidade não encontrada.' });

  const { data, error } = await supabase.from('barbeiros').select('*').eq('empresa_id', req.empresaId).eq('unidade_id', unidadeId);
  if (error) return res.status(500).json(error);
  res.json(data);
});

// --- Admins de cada unidade (só o admin de empresa gerencia — fora da allowlist de admin de
// unidade de propósito). Mesmo gate de plano das rotas de unidades acima (Enterprise).

router.get('/admin/unidades/:id/admins', async (req, res) => {
  const { data: unidade } = await supabase.from('unidades').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!unidade || unidade.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Unidade não encontrada.' });

  const { data, error } = await supabase
    .from('unidade_admins')
    .select('id, nome, email, ativo, criado_em')
    .eq('unidade_id', req.params.id)
    .order('criado_em');

  if (error) return res.status(500).json({ error: 'Erro ao listar administradores da unidade.' });
  res.json(data);
});

router.post('/admin/unidades/:id/admins', validate(unidadeAdminCriarSchema), async (req, res) => {
  const { nome, email, senha } = req.body;
  const empresa_id = req.empresaId;

  if (!(await permiteMultiUnidade(empresa_id))) {
    return res.status(403).json({ error: 'Multi-unidade é um recurso exclusivo do plano Enterprise.' });
  }

  const { data: unidade } = await supabase.from('unidades').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!unidade || unidade.empresa_id !== empresa_id) return res.status(404).json({ error: 'Unidade não encontrada.' });

  const senhaHash = await bcrypt.hash(senha, 10);

  const { data, error } = await supabase
    .from('unidade_admins')
    .insert({ empresa_id, unidade_id: req.params.id, nome, email, senha: senhaHash })
    .select('id, nome, email, ativo, criado_em')
    .single();

  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Já existe um admin com esse e-mail.' });
    return res.status(500).json({ error: 'Erro ao criar administrador da unidade.' });
  }
  res.status(201).json(data);
});

router.put('/admin/unidade-admins/:id/status', validate(ativoSchema), async (req, res) => {
  const { ativo } = req.body;

  const { data: admin } = await supabase.from('unidade_admins').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!admin || admin.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Administrador não encontrado.' });

  const { error } = await supabase.from('unidade_admins').update({ ativo }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar administrador.' });
  res.json({ success: true });
});

router.delete('/admin/unidade-admins/:id', async (req, res) => {
  const { data: admin } = await supabase.from('unidade_admins').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!admin || admin.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Administrador não encontrado.' });

  const { error } = await supabase.from('unidade_admins').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao remover administrador.' });
  res.json({ success: true });
});

module.exports = router;
