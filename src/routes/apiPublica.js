const express = require('express');
const supabase = require('../config/supabase');
const { autenticarApiKey } = require('../middleware/apiKeyAuth');
const { apiPublicaLimiter } = require('../middleware/rateLimiters');
const { limiteAgendamentosMesAtingido } = require('../utils/limitesPlano');

const router = express.Router();

// API pública (recurso Enterprise) — pensada pra um sistema externo do cliente (ex: o site
// institucional dele, ou um ERP próprio) consultar disponibilidade e criar agendamentos sem
// precisar do painel admin. Autenticação via API key (ver middleware/apiKeyAuth.js), não JWT.
router.use('/api/v1', apiPublicaLimiter, autenticarApiKey);

router.get('/api/v1/profissionais', async (req, res) => {
  const { data, error } = await supabase
    .from('barbeiros')
    .select('id, nome, ativo, unidade_id')
    .eq('empresa_id', req.empresaId)
    .eq('ativo', true);

  if (error) return res.status(500).json({ error: 'Erro ao listar profissionais.' });
  res.json(data);
});

router.get('/api/v1/servicos', async (req, res) => {
  const { data, error } = await supabase
    .from('servicos')
    .select('id, nome, duracao, valor')
    .eq('empresa_id', req.empresaId)
    .eq('ativo', true);

  if (error) return res.status(500).json({ error: 'Erro ao listar serviços.' });
  res.json(data);
});

router.get('/api/v1/disponibilidade', async (req, res) => {
  const { profissional_id, data } = req.query;
  if (!profissional_id || !data) return res.status(400).json({ error: 'Parâmetros profissional_id e data são obrigatórios.' });

  const { data: profissional } = await supabase
    .from('barbeiros')
    .select('id')
    .eq('id', profissional_id)
    .eq('empresa_id', req.empresaId)
    .maybeSingle();
  if (!profissional) return res.status(404).json({ error: 'Profissional não encontrado nesta conta.' });

  const { data: ocupados } = await supabase
    .from('agendamentos')
    .select('data_hora')
    .eq('barbeiro_id', profissional_id)
    .gte('data_hora', `${data}T00:00:00`)
    .lte('data_hora', `${data}T23:59:59`)
    .neq('status', 'cancelado');

  const horasOcupadas = new Set((ocupados || []).map((a) => new Date(a.data_hora).toISOString().slice(11, 16)));
  const slots = [];
  for (let h = 8; h < 20; h++) {
    for (const min of [0, 30]) {
      const hStr = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      if (!horasOcupadas.has(hStr)) slots.push(hStr);
    }
  }

  res.json({ profissional_id: Number(profissional_id), data, horarios_disponiveis: slots });
});

router.post('/api/v1/agendamentos', async (req, res) => {
  const { profissional_id, data_hora, servicos_ids, cliente_nome } = req.body;

  if (!profissional_id || !data_hora || !cliente_nome || !Array.isArray(servicos_ids) || servicos_ids.length === 0) {
    return res.status(400).json({ error: 'Campos obrigatórios: profissional_id, data_hora, cliente_nome, servicos_ids.' });
  }

  if (await limiteAgendamentosMesAtingido(req.empresaId)) {
    return res.status(403).json({ error: 'Esta conta atingiu o limite de agendamentos do mês.' });
  }

  const { data: servicosInfo, error: servErr } = await supabase
    .from('servicos')
    .select('id, duracao, valor')
    .eq('empresa_id', req.empresaId)
    .in('id', servicos_ids);

  if (servErr || !servicosInfo || servicosInfo.length === 0) {
    return res.status(400).json({ error: 'Serviços inválidos para esta conta.' });
  }

  const duracaoTotal = servicosInfo.reduce((acc, s) => acc + (s.duracao || 0), 0);
  const valorTotal = servicosInfo.reduce((acc, s) => acc + Number(s.valor || 0), 0);

  const { data: novoAgendamento, error } = await supabase
    .from('agendamentos')
    .insert({
      empresa_id: req.empresaId,
      barbeiro_id: profissional_id,
      data_hora,
      status: 'confirmado',
      cliente_nome,
      duracao_total: duracaoTotal,
      valor_total: valorTotal
    })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao criar agendamento.' });

  const vinculos = servicos_ids.map((servico_id) => ({ agendamento_id: novoAgendamento.id, servico_id }));
  await supabase.from('agendamento_servicos').insert(vinculos);

  res.status(201).json({ id: novoAgendamento.id, message: 'Agendamento criado com sucesso.' });
});

module.exports = router;
