const express = require('express');
const supabase = require('../config/supabase');
const { autenticarApiKey } = require('../middleware/apiKeyAuth');
const { apiPublicaLimiter } = require('../middleware/rateLimiters');
const { limiteAgendamentosMesAtingido } = require('../utils/limitesPlano');

const router = express.Router();

// API pública (recurso Enterprise), pensada pra um sistema externo do cliente (ex: o site
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

  const { data: empresa } = await supabase.from('empresas').select('horarios_funcionamento').eq('id', req.empresaId).maybeSingle();
  const diaSemana = new Date(`${data}T00:00:00Z`).getUTCDay();
  const horarioDia = JSON.parse(empresa?.horarios_funcionamento || '{}')[diaSemana];
  if (!horarioDia || !horarioDia.aberto) {
    return res.json({ profissional_id: Number(profissional_id), data, horarios_disponiveis: [] });
  }

  const { data: ocupados } = await supabase
    .from('agendamentos')
    .select('data_hora, duracao_total')
    .eq('barbeiro_id', profissional_id)
    .gte('data_hora', `${data}T00:00:00`)
    .lte('data_hora', `${data}T23:59:59`)
    .neq('status', 'cancelado');

  // Cada slot de 30min é considerado ocupado se cai dentro de [início, início + duração) de
  // algum agendamento existente — antes só marcava o minuto exato de início, então um serviço
  // de 45min ocupando 09:00-09:45 deixava 09:30 aparecer como livre.
  const intervalosOcupados = (ocupados || []).map((a) => {
    const inicio = new Date(a.data_hora);
    const fim = new Date(inicio.getTime() + (a.duracao_total || 0) * 60000);
    return { inicio, fim };
  });

  const [horaAbre, minAbre] = horarioDia.abre.split(':').map(Number);
  const [horaFecha, minFecha] = horarioDia.fecha.split(':').map(Number);
  const slots = [];
  for (let min = horaAbre * 60 + minAbre; min < horaFecha * 60 + minFecha; min += 30) {
    const hStr = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    const inicioSlot = new Date(`${data}T${hStr}:00Z`);
    const ocupado = intervalosOcupados.some((iv) => inicioSlot >= iv.inicio && inicioSlot < iv.fim);
    if (!ocupado) slots.push(hStr);
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

  // Sem isso, essa API pública permitia double-booking: dois agendamentos podiam ser criados
  // pro mesmo profissional em horários que se sobrepõem, diferente do fluxo normal (frontend),
  // que só oferece horários livres. Busca o dia inteiro do profissional e checa sobreposição
  // de intervalo em JS, mesma lógica usada em /disponibilidade e /disponibilidade-filtro.
  const inicioNovo = new Date(data_hora);
  const fimNovo = new Date(inicioNovo.getTime() + duracaoTotal * 60000);
  const diaISO = inicioNovo.toISOString().slice(0, 10);
  const { data: existentes, error: existErr } = await supabase
    .from('agendamentos')
    .select('data_hora, duracao_total')
    .eq('barbeiro_id', profissional_id)
    .gte('data_hora', `${diaISO}T00:00:00`)
    .lte('data_hora', `${diaISO}T23:59:59`)
    .neq('status', 'cancelado');

  if (existErr) return res.status(500).json({ error: 'Erro ao checar disponibilidade.' });

  const conflito = (existentes || []).some((a) => {
    const inicio = new Date(a.data_hora);
    const fim = new Date(inicio.getTime() + (a.duracao_total || 0) * 60000);
    return inicioNovo < fim && fimNovo > inicio;
  });
  if (conflito) return res.status(409).json({ error: 'Esse profissional já tem um agendamento nesse horário.' });

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
  const { error: vincError } = await supabase.from('agendamento_servicos').insert(vinculos);
  if (vincError) console.error('Erro ao vincular serviços do agendamento (API pública):', vincError);

  res.status(201).json({ id: novoAgendamento.id, message: 'Agendamento criado com sucesso.' });
});

module.exports = router;
