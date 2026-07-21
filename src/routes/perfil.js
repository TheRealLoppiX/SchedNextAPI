const express = require('express');
const supabase = require('../config/supabase');

const router = express.Router();

router.put('/notificacoes/ler-todas/:userId', async (req, res) => {
  const { userId } = req.params;
  const { error } = await supabase.from('notificacoes').update({ lida: true }).eq('usuario_id', userId);
  if (error) return res.status(500).json(error);
  res.json({ message: 'Notificações lidas' });
});

router.get('/notificacoes/:userId', async (req, res) => {
  const { data, error } = await supabase
    .from('notificacoes')
    .select('*')
    .eq('usuario_id', req.params.userId)
    .order('criado_em', { ascending: false })
    .limit(15);

  if (error) return res.status(500).json(error);
  res.json(data);
});

router.get('/meus-agendamentos/:id', async (req, res) => {
  const { data: agendamentos, error } = await supabase
    .from('agendamentos')
    .select('id, data_hora, valor_total, barbeiro_id, status, barbeiros(nome), agendamento_servicos(servicos(nome))')
    .eq('usuario_id', req.params.id)
    .order('data_hora', { ascending: false });

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao carregar histórico' });
  }

  const ids = agendamentos.map((a) => a.id);
  let avaliados = new Set();
  if (ids.length > 0) {
    const { data: avals } = await supabase.from('avaliacoes').select('agendamento_id').in('agendamento_id', ids);
    avaliados = new Set((avals || []).map((a) => a.agendamento_id));
  }

  const agora = new Date();
  const resultado = agendamentos.map((a) => ({
    id: a.id,
    data_hora: a.data_hora,
    valor_total: a.valor_total,
    barbeiro_id: a.barbeiro_id,
    barbeiro: a.barbeiros ? a.barbeiros.nome : null,
    servicos: (a.agendamento_servicos || []).map((as) => as.servicos && as.servicos.nome).filter(Boolean).join(', '),
    status: new Date(a.data_hora) < agora && a.status === 'pendente' ? 'expirado' : a.status,
    ja_avaliado: avaliados.has(a.id) ? 1 : 0
  }));

  res.json(resultado);
});

router.get('/usuarios/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('usuarios')
    .select('nome_completo, email, telefone, foto_url, data_nascimento')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Não encontrado' });
  res.json(data);
});

router.put('/atualizar-perfil/:id', async (req, res) => {
  const { nome_completo, telefone, nascimento, foto_url } = req.body;
  const usuarioId = req.params.id;

  const { error } = await supabase
    .from('usuarios')
    .update({ nome_completo, telefone, data_nascimento: nascimento, foto_url })
    .eq('id', usuarioId);

  if (error) {
    console.error('Erro Supabase:', error);
    return res.status(500).json({ error: 'Erro ao salvar' });
  }
  res.json({ message: 'Sucesso' });
});

router.put('/cancelar-agendamento/:id', async (req, res) => {
  const { id } = req.params;

  const { data: agendamento, error: selError } = await supabase
    .from('agendamentos')
    .select('data_hora')
    .eq('id', id)
    .maybeSingle();

  if (selError) return res.status(500).json({ error: 'Erro interno' });
  if (!agendamento) return res.status(404).json({ error: 'Agendamento não encontrado' });

  if (new Date(agendamento.data_hora) < new Date()) {
    return res.status(400).json({ error: 'Não é possível cancelar horários passados.' });
  }

  const { error } = await supabase.from('agendamentos').update({ status: 'cancelado' }).eq('id', id);
  if (error) return res.status(500).json({ error: 'Erro ao cancelar no banco' });
  res.json({ message: 'Agendamento cancelado com sucesso!' });
});

router.post('/avaliar', async (req, res) => {
  const { agendamento_id, cliente_id, barbeiro_id, nota, comentario } = req.body;

  const { data: agendamento, error: selError } = await supabase
    .from('agendamentos')
    .select('status')
    .eq('id', agendamento_id)
    .maybeSingle();

  if (selError) return res.status(500).json({ error: 'Erro ao verificar agendamento.' });
  if (!agendamento) return res.status(404).json({ error: 'Agendamento não encontrado.' });

  // Nota: o ENUM real de status no Postgres só tem pendente/confirmado/concluido/cancelado —
  // 'finalizado' nunca existiu como valor válido (ver database-schema.md), então checamos só 'concluido'.
  if (agendamento.status !== 'concluido') {
    return res.status(403).json({ error: 'Aguarde a finalização do seu corte pelo barbeiro para enviar a avaliação.' });
  }

  const { error } = await supabase
    .from('avaliacoes')
    .insert({ agendamento_id, cliente_id, barbeiro_id, nota, comentario });

  if (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Você já avaliou este atendimento.' });
    }
    return res.status(500).json({ error: 'Erro ao salvar avaliação.' });
  }
  res.json({ success: true, message: 'Avaliação salva com sucesso!' });
});

// --- FIDELIDADE (DINÂMICA) ---
router.get('/fidelidade/:userId', async (req, res) => {
  const { userId } = req.params;

  const { data: usuario, error: userErr } = await supabase
    .from('usuarios')
    .select('empresa_id')
    .eq('id', userId)
    .maybeSingle();

  if (userErr || !usuario) return res.status(404).json({ error: 'Usuário não encontrado' });

  const { data: campanha, error: campErr } = await supabase
    .from('campanhas_fidelidade')
    .select('*')
    .eq('empresa_id', usuario.empresa_id)
    .eq('ativa', true)
    .limit(1)
    .maybeSingle();

  if (campErr) return res.status(500).json({ error: 'Erro ao buscar campanha' });
  if (!campanha) return res.json({ ativa: false });

  // Nota: só 'concluido' é um valor válido do ENUM real (ver comentário em /avaliar acima).
  const { count, error: countErr } = await supabase
    .from('agendamentos')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', userId)
    .eq('status', 'concluido')
    .gte('data_hora', `${campanha.data_inicio}T00:00:00`)
    .lte('data_hora', `${campanha.data_fim}T23:59:59`)
    .gte('valor_total', campanha.valor_minimo);

  if (countErr) return res.status(500).json({ error: 'Erro ao calcular progresso' });

  const concluidos = count || 0;
  const progresso = Math.min(concluidos, campanha.cortes_necessarios);
  const faltam = campanha.cortes_necessarios - progresso;
  const ganhouPremio = progresso >= campanha.cortes_necessarios;

  res.json({
    ativa: true,
    nome: campanha.nome,
    data_inicio: campanha.data_inicio,
    data_fim: campanha.data_fim,
    valor_minimo: campanha.valor_minimo,
    objetivo: campanha.cortes_necessarios,
    premio: campanha.premio_descritivo,
    progresso,
    faltam,
    ganhouPremio
  });
});

// Verificar assinante e retornar servicos do plano (para o app do cliente)
router.get('/usuario/:id/assinante', async (req, res) => {
  const { data: usuario, error } = await supabase
    .from('usuarios')
    .select('assinante, plano_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !usuario) return res.json({ assinante: false, servicos_ids: [] });

  let servicosIds = [];
  if (usuario.plano_id) {
    const { data: planoServicos } = await supabase
      .from('plano_servicos')
      .select('servico_id')
      .eq('plano_id', usuario.plano_id);
    servicosIds = (planoServicos || []).map((ps) => ps.servico_id);
  }

  res.json({
    assinante: !!usuario.assinante,
    plano_id: usuario.plano_id,
    servicos_ids: servicosIds
  });
});

module.exports = router;
