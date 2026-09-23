const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { suporteMensagemSchema } = require('../schemas');
const { permiteIA } = require('../utils/limitesPlano');
const { responderSuporte } = require('../services/suporte');
const { nomeDoEmail } = require('../utils/nomeAdmin');

const router = express.Router();

// Módulo de suporte do admin de empresa — hoje vive como widget flutuante (botão de FAQ) em vez
// de página dedicada, ver frontend/src/components/SuporteFlutuante.js. Reaproveita o mesmo flag
// de plano permite_ia já usado pro bot de WhatsApp (Profissional/Enterprise) — decisão de produto:
// só esses planos ganham chat com IA + escalação pra um humano; Grátis/Essencial ficam com
// contato por e-mail (sem rota nem tabela nenhuma pra isso, é só um link no front).

function mapConversa(c) {
  return {
    id: c.id,
    status: c.status,
    criado_em: c.criado_em,
    atualizado_em: c.atualizado_em,
    atendido_por_nome: c.atendido_por?.email ? nomeDoEmail(c.atendido_por.email) : null
  };
}

// Busca a conversa ativa (não resolvida) da empresa, se existir — nunca cria uma vazia aqui,
// só quando a primeira mensagem é mandada (ver POST /admin/suporte/mensagem).
router.get('/admin/suporte', async (req, res) => {
  const empresa_id = req.empresaId;
  const permitido = await permiteIA(empresa_id);
  if (!permitido) return res.json({ permitido: false, conversa: null, mensagens: [] });

  const { data: conversa } = await supabase
    .from('suporte_conversas')
    .select('id, status, criado_em, atualizado_em, atendido_por:atendido_por_super_admin_id(email)')
    .eq('empresa_id', empresa_id)
    .neq('status', 'resolvido')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conversa) return res.json({ permitido: true, conversa: null, mensagens: [] });

  const { data: mensagens, error } = await supabase
    .from('suporte_mensagens')
    .select('id, remetente, texto, criado_em, super_admin:super_admin_id(email)')
    .eq('conversa_id', conversa.id)
    .order('criado_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao carregar conversa.' });
  res.json({
    permitido: true,
    conversa: mapConversa(conversa),
    mensagens: (mensagens || []).map((m) => ({ ...m, nome_admin: m.super_admin?.email ? nomeDoEmail(m.super_admin.email) : null }))
  });
});

// Histórico completo (todas as conversas, incluindo resolvidas) — a empresa sempre pode ver o
// que já conversou antes, mesmo depois de encerrado.
router.get('/admin/suporte/historico', async (req, res) => {
  const empresa_id = req.empresaId;
  if (!(await permiteIA(empresa_id))) return res.json([]);

  const { data, error } = await supabase
    .from('suporte_conversas')
    .select('id, status, criado_em, atualizado_em, atendido_por:atendido_por_super_admin_id(email)')
    .eq('empresa_id', empresa_id)
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erro ao carregar histórico.' });
  res.json((data || []).map(mapConversa));
});

// Uma conversa específica do histórico (inclusive resolvida) — sempre confere que é desta
// empresa antes de devolver qualquer coisa.
router.get('/admin/suporte/historico/:id', async (req, res) => {
  const empresa_id = req.empresaId;
  const { data: conversa } = await supabase
    .from('suporte_conversas')
    .select('id, status, criado_em, atualizado_em, empresa_id, atendido_por:atendido_por_super_admin_id(email)')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!conversa || conversa.empresa_id !== empresa_id) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const { data: mensagens, error } = await supabase
    .from('suporte_mensagens')
    .select('id, remetente, texto, criado_em, super_admin:super_admin_id(email)')
    .eq('conversa_id', conversa.id)
    .order('criado_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao carregar conversa.' });
  res.json({
    conversa: mapConversa(conversa),
    mensagens: (mensagens || []).map((m) => ({ ...m, nome_admin: m.super_admin?.email ? nomeDoEmail(m.super_admin.email) : null }))
  });
});

// Manda uma mensagem: cria a conversa se não existir uma ativa, grava a mensagem da empresa e,
// só se a conversa ainda não foi escalada (status 'ia'), gera e grava a resposta da IA na hora —
// depois de escalada (status 'aguardando_humano'), a IA para de responder pra não atropelar quem
// está atendendo de verdade.
router.post('/admin/suporte/mensagem', validate(suporteMensagemSchema), async (req, res) => {
  const empresa_id = req.empresaId;
  if (!(await permiteIA(empresa_id))) return res.status(403).json({ error: 'Recurso não disponível no seu plano.' });

  let { data: conversa } = await supabase
    .from('suporte_conversas')
    .select('id, status')
    .eq('empresa_id', empresa_id)
    .neq('status', 'resolvido')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conversa) {
    const { data: nova, error: erroNova } = await supabase
      .from('suporte_conversas')
      .insert({ empresa_id, status: 'ia' })
      .select('id, status')
      .single();
    if (erroNova) return res.status(500).json({ error: 'Erro ao iniciar conversa de suporte.' });
    conversa = nova;
  }

  const { error: erroMsg } = await supabase
    .from('suporte_mensagens')
    .insert({ conversa_id: conversa.id, remetente: 'empresa', texto: req.body.texto });
  if (erroMsg) return res.status(500).json({ error: 'Erro ao enviar mensagem.' });

  if (conversa.status === 'ia') {
    const { data: historicoDb } = await supabase
      .from('suporte_mensagens')
      .select('remetente, texto')
      .eq('conversa_id', conversa.id)
      .order('criado_em', { ascending: true });

    // A mensagem que acabou de ser gravada já entra no histórico — remove ela daqui (vai como
    // "novaMensagem" separada pra responderSuporte) pra não mandar duas vezes pra IA.
    const historico = (historicoDb || [])
      .slice(0, -1)
      .map((m) => ({ role: m.remetente === 'ia' ? 'assistant' : 'user', content: m.texto }));

    const respostaIA = await responderSuporte(historico, req.body.texto);
    await supabase.from('suporte_mensagens').insert({ conversa_id: conversa.id, remetente: 'ia', texto: respostaIA });
  }

  await supabase.from('suporte_conversas').update({ atualizado_em: new Date().toISOString() }).eq('id', conversa.id);

  const { data: mensagens } = await supabase
    .from('suporte_mensagens')
    .select('id, remetente, texto, criado_em, super_admin:super_admin_id(email)')
    .eq('conversa_id', conversa.id)
    .order('criado_em', { ascending: true });

  res.json({
    conversa: { id: conversa.id, status: conversa.status },
    mensagens: (mensagens || []).map((m) => ({ ...m, nome_admin: m.super_admin?.email ? nomeDoEmail(m.super_admin.email) : null }))
  });
});

// Escala pra um humano — a partir daqui a IA para de responder, e a conversa aparece pro admin
// absoluto em Admin absoluto -> Suporte.
router.post('/admin/suporte/escalar', async (req, res) => {
  const empresa_id = req.empresaId;
  const { data: conversa } = await supabase
    .from('suporte_conversas')
    .select('id')
    .eq('empresa_id', empresa_id)
    .neq('status', 'resolvido')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conversa) return res.status(404).json({ error: 'Nenhuma conversa em andamento.' });

  const { error } = await supabase
    .from('suporte_conversas')
    .update({ status: 'aguardando_humano', atualizado_em: new Date().toISOString() })
    .eq('id', conversa.id);
  if (error) return res.status(500).json({ error: 'Erro ao escalar a conversa.' });
  res.json({ success: true });
});

// Encerra a conversa do lado da empresa (ex: já resolveu sozinho, ou a resposta do time já foi
// suficiente) — libera a empresa pra abrir uma conversa nova depois.
router.post('/admin/suporte/resolver', async (req, res) => {
  const empresa_id = req.empresaId;
  const { data, error } = await supabase
    .from('suporte_conversas')
    .update({ status: 'resolvido', atualizado_em: new Date().toISOString() })
    .eq('empresa_id', empresa_id)
    .neq('status', 'resolvido')
    .select('id');

  if (error) return res.status(500).json({ error: 'Erro ao encerrar a conversa.' });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Nenhuma conversa em andamento.' });
  res.json({ success: true });
});

module.exports = router;
