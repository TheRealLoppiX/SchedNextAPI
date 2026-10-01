const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { assinaturaPlanoSchema, ativoSchema, clientePlanoSchema, assinaturaConfigSchema } = require('../schemas');
const { calcularProximaCobranca } = require('../utils/limitesAssinatura');
const { proximaDataComAlgumDia } = require('../services/vencimentoAssinatura');

const router = express.Router();

// Listar planos com servicos e total de assinantes
router.get('/admin/assinaturas/:empresaId', async (req, res) => {
  const empresaId = req.empresaId;

  const { data: planos, error } = await supabase
    .from('planos_assinatura')
    .select('id, nome, preco, descricao, ativo, criado_em, dias_semana, plano_servicos(servicos(id, nome), limite_mensal)')
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
      dias_semana: p.dias_semana || null,
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
    .select('id, nome, preco, dias_semana')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !data) return res.status(404).json({});
  res.json(data);
});

// Criar plano
router.post('/admin/assinaturas', validate(assinaturaPlanoSchema), async (req, res) => {
  const { nome, preco, descricao, servicos, dias_semana } = req.body;
  const empresa_id = req.empresaId;

  try {
    const { data: plano, error } = await supabase
      .from('planos_assinatura')
      .insert({ empresa_id, nome, preco, descricao: descricao || null, dias_semana: dias_semana ?? null })
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
  const { nome, preco, descricao, servicos, dias_semana } = req.body;

  try {
    const { data: planoAtual } = await supabase.from('planos_assinatura').select('empresa_id').eq('id', id).maybeSingle();
    if (!planoAtual || planoAtual.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Plano não encontrado.' });

    const { error } = await supabase
      .from('planos_assinatura')
      .update({ nome, preco, descricao: descricao || null, dias_semana: dias_semana ?? null })
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

// --- Vencimento das mensalidades (ver services/vencimentoAssinatura.js) ---
// Caminho fora de /admin/assinaturas/* de propósito: /admin/assinaturas/:empresaId engoliria
// "/admin/assinaturas/config".
router.get('/admin/assinatura-config', async (req, res) => {
  const { data, error } = await supabase
    .from('empresas')
    .select('assinatura_modo_vencimento, assinatura_dias_vencimento, assinatura_primeira_cobranca')
    .eq('id', req.empresaId)
    .maybeSingle();
  if (error || !data) return res.status(500).json({ error: 'Erro ao buscar a configuração.' });

  // Quantos já estão com a migração pros dias fixos agendada (aparece na tela).
  const { count } = await supabase
    .from('usuarios')
    .select('id', { count: 'exact', head: true })
    .eq('empresa_id', req.empresaId)
    .not('vencimento_migrar_em', 'is', null);

  res.json({
    modo_vencimento: data.assinatura_modo_vencimento,
    dias_vencimento: data.assinatura_dias_vencimento || [],
    primeira_cobranca: data.assinatura_primeira_cobranca,
    migracoes_agendadas: count || 0
  });
});

router.put('/admin/assinatura-config', validate(assinaturaConfigSchema), async (req, res) => {
  const { modo_vencimento, dias_vencimento, primeira_cobranca, migrar_atuais } = req.body;
  const diasFixos = modo_vencimento === 'dias_fixos';

  const { error } = await supabase
    .from('empresas')
    .update({
      assinatura_modo_vencimento: modo_vencimento,
      assinatura_dias_vencimento: diasFixos ? dias_vencimento : null,
      assinatura_primeira_cobranca: primeira_cobranca
    })
    .eq('id', req.empresaId);
  if (error) return res.status(500).json({ error: 'Erro ao salvar a configuração.' });

  // Voltar pro modo normal desfaz migrações ainda não aplicadas.
  if (!diasFixos) {
    await supabase.from('usuarios')
      .update({ vencimento_migrar_em: null, vencimento_nova_ancora: null })
      .eq('empresa_id', req.empresaId)
      .not('vencimento_migrar_em', 'is', null);
    return res.json({ success: true, message: 'Configuração salva.' });
  }

  if (!migrar_atuais) return res.json({ success: true, message: 'Configuração salva. Os dias fixos valem pras novas assinaturas.' });

  // Migra quem já assina: agenda a troca pra próxima cobrança de cada um (o cron aplica nesse
  // dia, ver cron/cobrancaAssinaturas.js). Cartão fica na data atual: mudar o dia do cartão exige
  // o cliente autorizar um cartão de novo (dá pra fazer um a um em "alterar vencimento").
  const { data: assinantes, error: errAss } = await supabase
    .from('usuarios')
    .select('id, assinante_desde, assinatura_forma_pagamento')
    .eq('empresa_id', req.empresaId)
    .eq('assinante', true)
    .not('plano_id', 'is', null)
    .not('assinante_desde', 'is', null);
  if (errAss) return res.status(500).json({ error: 'Configuração salva, mas não foi possível migrar os assinantes atuais.' });

  let agendados = 0;
  let jaNoDia = 0;
  let cartao = 0;
  for (const a of assinantes || []) {
    if (a.assinatura_forma_pagamento === 'cartao') { cartao += 1; continue; }
    const proxima = calcularProximaCobranca(a.assinante_desde);
    if (dias_vencimento.includes(Number(proxima.slice(8, 10)))) { jaNoDia += 1; continue; }
    const { error: migErr } = await supabase.from('usuarios')
      .update({ vencimento_migrar_em: proxima, vencimento_nova_ancora: proximaDataComAlgumDia(proxima, dias_vencimento) })
      .eq('id', a.id);
    if (migErr) console.error(`Erro ao agendar migração de vencimento do cliente ${a.id}:`, migErr);
    else agendados += 1;
  }

  const partes = [`${agendados} assinante(s) passam pro dia fixo na próxima cobrança`];
  if (jaNoDia) partes.push(`${jaNoDia} já vencem num dos dias escolhidos`);
  if (cartao) partes.push(`${cartao} no cartão continuam na data atual`);
  res.json({ success: true, message: `Configuração salva. ${partes.join('; ')}.` });
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

  const { data: cliente } = await supabase.from('usuarios').select('empresa_id, assinante, assinante_desde, plano_id').eq('id', req.params.id).maybeSingle();
  if (!cliente || cliente.empresa_id !== empresa_id) return res.status(404).json({ error: 'Cliente não encontrado.' });

  if (plano_id) {
    const { data: plano } = await supabase.from('planos_assinatura').select('empresa_id').eq('id', plano_id).maybeSingle();
    if (!plano || plano.empresa_id !== empresa_id) return res.status(404).json({ error: 'Plano não encontrado.' });
  }

  // assinante_desde ancora o ciclo rolante de uso mensal (ver utils/limitesAssinatura.js). Só
  // seta na primeira ativação: trocar de plano com o cliente já assinante não deve resetar o
  // ciclo/consumo em andamento.
  const primeiraAtivacao = !!plano_id && (!cliente.assinante || !cliente.assinante_desde);

  // status_assinatura só pode virar 'em_dia' com uma baixa real (manual ou pagamento
  // confirmado, ver marcarEmDia em services/cobrancaAssinatura.js). Qualquer vínculo novo de
  // plano volta pra 'pendente': tanto a primeira ativação (sem isso o cliente nascia com o
  // default 'em_dia' da coluna, sem cobrança nenhuma) quanto uma troca de plano num cliente já
  // assinante (o 'em_dia' que ele tinha valia pro preço do plano ANTERIOR, não pro novo).
  const trocouDePlano = !!plano_id && cliente.plano_id !== plano_id;
  const update = plano_id
    ? {
        plano_id,
        assinante: true,
        ...(primeiraAtivacao && { assinante_desde: new Date().toISOString().split('T')[0] }),
        ...(trocouDePlano && { status_assinatura: 'pendente' })
      }
    : { plano_id: null, assinante: false };

  const { error } = await supabase.from('usuarios').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
