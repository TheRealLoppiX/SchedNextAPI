const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { servicoGestaoSchema, ativoSchema } = require('../schemas');

const router = express.Router();

router.get('/servicos', async (req, res) => {
  const { empresa } = req.query;

  // Só aceita slug (letras/números/hífen/underscore) ou ID numérico. Evita que um valor
  // com vírgula/operador (ex: "x,id.gt.0") injete cláusulas extras no `.or()` do PostgREST
  // abaixo, que monta a string do filtro por interpolação direta.
  if (!empresa || !/^[a-zA-Z0-9_-]+$/.test(String(empresa))) {
    return res.status(400).json({ error: 'O slug da empresa é obrigatório' });
  }

  // Nota: o SQL original era `WHERE e.slug = ? OR e.id = ? AND s.ativo = 1`, e por precedência
  // de operadores (AND antes de OR) isso equivale a `e.slug = ? OR (e.id = ? AND s.ativo = 1)`.
  // Ou seja: quando a busca é por SLUG, o filtro de `ativo` nunca era aplicado (bug pré-existente
  // do MySQL, preservado aqui de propósito para não mudar comportamento fora do escopo da migração).
  const porId = /^\d+$/.test(String(empresa));

  const { data: emp, error: empErr } = await supabase
    .from('empresas')
    .select('id')
    .or(`slug.eq.${empresa},id.eq.${porId ? empresa : 0}`)
    .maybeSingle();

  if (empErr || !emp) return res.json([]);

  let query = supabase.from('servicos').select('id, nome, duracao, valor').eq('empresa_id', emp.id);
  if (porId) query = query.eq('ativo', true);

  const { data, error } = await query;
  if (error) {
    console.error('Erro no Banco:', error);
    return res.status(500).json({ error: 'Erro ao buscar serviços' });
  }
  res.json(data);
});

// BUSCAR SERVIÇOS (Dashboard Admin). Vive sob /admin/*, usa req.empresaId (do token
// verificado), ignorando ?empresa= da query pra um admin não conseguir ler os serviços de
// outro tenant só trocando o valor.
router.get('/admin/servicos', async (req, res) => {
  const { data, error } = await supabase.from('servicos').select('id, nome, duracao, valor').eq('empresa_id', req.empresaId);
  if (error) return res.status(500).json({ error: 'Erro interno' });
  res.json(data);
});

router.get('/horarios-ocupados', async (req, res) => {
  const { barbeiro_id, data } = req.query; // 'data' vem do front como '2026-02-17'

  if (!barbeiro_id || !data) {
    return res.status(400).json({ error: 'Faltando barbeiro_id ou data' });
  }

  const { data: agendados, error: errAg } = await supabase
    .from('agendamentos')
    .select('data_hora, duracao_total')
    .eq('barbeiro_id', barbeiro_id)
    .gte('data_hora', `${data}T00:00:00`)
    .lte('data_hora', `${data}T23:59:59`)
    .neq('status', 'cancelado');

  if (errAg) {
    console.error('Erro SQL Agendados:', errAg);
    return res.status(500).json(errAg);
  }

  const { data: bloqueios, error: errBq } = await supabase
    .from('bloqueios')
    .select('hora_inicio, hora_fim')
    .eq('barbeiro_id', barbeiro_id)
    .lte('data_bloqueio', data)
    .gte('data_fim', data);

  if (errBq) {
    console.error('Erro SQL Bloqueios:', errBq);
    return res.status(500).json(errBq);
  }

  res.json({
    agendados: (agendados || []).map((a) => ({
      hora: new Date(a.data_hora).toISOString().slice(11, 16),
      duracao_total: a.duracao_total
    })),
    bloqueios: bloqueios || []
  });
});

// LISTAR serviços da empresa logada. Movida para /admin/* (verificarTokenAdmin garante
// req.empresaId). Antes vivia em "/servicos-gestao/:empresa_id" sem nenhuma autenticação:
// qualquer chamador anônimo podia listar/criar/editar/excluir os serviços de qualquer
// empresa só sabendo (ou adivinhando) o ID.
router.get('/admin/servicos-gestao', async (req, res) => {
  const { data, error } = await supabase
    .from('servicos')
    .select('*')
    .eq('empresa_id', req.empresaId)
    .order('nome', { ascending: true });

  if (error) return res.status(500).json(error);
  res.json(data);
});

// CADASTRAR novo serviço
router.post('/admin/servicos-gestao', validate(servicoGestaoSchema), async (req, res) => {
  const { nome, valor, duracao, descricao } = req.body;

  const { data, error } = await supabase
    .from('servicos')
    .insert({ nome, valor, duracao, empresa_id: req.empresaId, descricao: descricao || null })
    .select('id')
    .single();

  if (error) return res.status(500).json(error);
  res.json({ message: 'Serviço criado!', id: data.id });
});

// ATUALIZAR serviço existente
router.put('/admin/servicos-gestao/:id', validate(servicoGestaoSchema), async (req, res) => {
  const { nome, valor, duracao, descricao } = req.body;
  const { data, error } = await supabase
    .from('servicos')
    .update({ nome, valor, duracao, descricao: descricao || null })
    .eq('id', req.params.id)
    .eq('empresa_id', req.empresaId)
    .select('id');

  if (error) return res.status(500).json(error);
  if (!data || data.length === 0) return res.status(404).json({ error: 'Serviço não encontrado.' });
  res.json({ message: 'Serviço atualizado com sucesso!' });
});

// EXCLUIR serviço
router.delete('/admin/servicos-gestao/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('servicos')
    .delete()
    .eq('id', req.params.id)
    .eq('empresa_id', req.empresaId)
    .select('id');

  if (error) return res.status(500).json(error);
  if (!data || data.length === 0) return res.status(404).json({ error: 'Serviço não encontrado.' });
  res.json({ message: 'Serviço removido!' });
});

router.put('/admin/servicos-gestao/:id/status', validate(ativoSchema), async (req, res) => {
  const { ativo } = req.body;
  const { data, error } = await supabase
    .from('servicos')
    .update({ ativo: !!ativo })
    .eq('id', req.params.id)
    .eq('empresa_id', req.empresaId)
    .select('id');

  if (error) return res.status(500).json({ error: 'Erro ao atualizar status' });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Serviço não encontrado.' });
  res.json({ message: 'Status atualizado!' });
});

router.get('/servicos-por-barbeiro/:barbeiro_id', async (req, res) => {
  const { data, error } = await supabase
    .from('barbeiro_servicos')
    .select('servicos(*)')
    .eq('barbeiro_id', req.params.barbeiro_id);

  if (error) {
    console.error('Erro no SQL:', error);
    return res.status(500).json(error);
  }
  res.json(data.map((r) => r.servicos).filter(Boolean));
});

// FILTRAGEM DE DISPONIBILIDADE (agendamentos + bloqueios)
router.get('/disponibilidade-filtro', async (req, res) => {
  const { data, hora, empresa } = req.query;

  if (!data || !hora) {
    return res.status(400).json({ error: 'Data e hora são necessários' });
  }

  // Mesma validação/resolução de slug-ou-id usada em GET /servicos acima. Sem isso, a query
  // de agendamentos abaixo varria TODOS os agendamentos da plataforma inteira a cada consulta
  // de disponibilidade, não só os da empresa em questão — um full table scan crescente junto
  // com a base, embora sem vazar dado sensível (só devolvia barbeiro_ids ocupados).
  if (!empresa || !/^[a-zA-Z0-9_-]+$/.test(String(empresa))) {
    return res.status(400).json({ error: 'O slug da empresa é obrigatório' });
  }
  const porId = /^\d+$/.test(String(empresa));
  const { data: emp, error: empErr } = await supabase
    .from('empresas')
    .select('id')
    .or(`slug.eq.${empresa},id.eq.${porId ? empresa : 0}`)
    .maybeSingle();

  if (empErr || !emp) return res.status(404).json({ error: 'Empresa não encontrada' });

  // Z explícito: os data_hora armazenados são tratados como UTC (é como o Postgres/Supabase
  // interpretou os DATETIME "ingênuos" que vieram do MySQL); sem o Z, o Node.js interpretaria
  // essa string como horário local da máquina, o que quebraria a comparação.
  const horarioDesejado = new Date(`${data}T${hora}:00Z`);
  const horaDesejada = `${hora}:00`;

  // O SQL original filtrava status NOT IN ('cancelado', 'rejeitado'), mas 'rejeitado'
  // nunca foi um valor válido do ENUM real (ver database-schema.md); mantemos só 'cancelado'.
  const { data: agendamentos, error: errAg } = await supabase
    .from('agendamentos')
    .select('barbeiro_id, data_hora, agendamento_servicos(servicos(duracao))')
    .eq('empresa_id', emp.id)
    .neq('status', 'cancelado');

  if (errAg) {
    console.error('Erro SQL Agendamentos:', errAg);
    return res.status(500).json({ error: 'Erro interno' });
  }

  const idsAgendados = agendamentos
    .filter((a) => {
      const inicio = new Date(a.data_hora);
      const duracaoTotal = (a.agendamento_servicos || []).reduce(
        (soma, as) => soma + (as.servicos ? as.servicos.duracao : 0),
        0
      );
      const fim = new Date(inicio.getTime() + duracaoTotal * 60000);
      return horarioDesejado >= inicio && horarioDesejado < fim;
    })
    .map((a) => a.barbeiro_id);

  const { data: bloqueios, error: errBq } = await supabase
    .from('bloqueios')
    .select('barbeiro_id')
    .lte('data_bloqueio', data)
    .gte('data_fim', data)
    .lte('hora_inicio', horaDesejada)
    .gt('hora_fim', horaDesejada);

  if (errBq) {
    console.error('Erro SQL Bloqueios:', errBq);
    return res.status(500).json({ error: 'Erro interno' });
  }

  const idsBloqueados = (bloqueios || []).map((r) => r.barbeiro_id);
  const idsOcupados = [...new Set([...idsAgendados, ...idsBloqueados])];

  res.json({ idsOcupados });
});

module.exports = router;
