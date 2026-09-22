const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { suporteMensagemSchema } = require('../schemas');

const router = express.Router();

// Lado do admin absoluto do módulo de suporte (ver routes/suporte.js pro lado da empresa).
// Lista conversas escaladas (status='aguardando_humano') de qualquer empresa da plataforma,
// mais as já resolvidas recentemente pra dar contexto de histórico.
router.get('/super-admin/suporte', async (req, res) => {
  const { data, error } = await supabase
    .from('suporte_conversas')
    .select('id, empresa_id, status, criado_em, atualizado_em, empresas(nome, slug)')
    .neq('status', 'ia') // conversas ainda só com a IA (não escaladas) não interessam aqui
    .order('atualizado_em', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: 'Erro ao listar conversas de suporte.' });

  const resultado = (data || []).map((c) => ({
    id: c.id,
    empresa_id: c.empresa_id,
    nome_empresa: c.empresas?.nome || 'Empresa',
    slug_empresa: c.empresas?.slug || null,
    status: c.status,
    criado_em: c.criado_em,
    atualizado_em: c.atualizado_em
  }));
  res.json(resultado);
});

router.get('/super-admin/suporte/:id', async (req, res) => {
  const { data: conversa, error: erroConversa } = await supabase
    .from('suporte_conversas')
    .select('id, empresa_id, status, criado_em, atualizado_em, empresas(nome, slug)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (erroConversa || !conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const { data: mensagens, error } = await supabase
    .from('suporte_mensagens')
    .select('id, remetente, texto, criado_em, super_admin:super_admin_id(email)')
    .eq('conversa_id', req.params.id)
    .order('criado_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao carregar a conversa.' });
  res.json({
    conversa: {
      id: conversa.id,
      empresa_id: conversa.empresa_id,
      nome_empresa: conversa.empresas?.nome || 'Empresa',
      status: conversa.status
    },
    mensagens: mensagens || []
  });
});

router.post('/super-admin/suporte/:id/mensagem', validate(suporteMensagemSchema), async (req, res) => {
  const { data: conversa } = await supabase.from('suporte_conversas').select('id, status').eq('id', req.params.id).maybeSingle();
  if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const { error } = await supabase.from('suporte_mensagens').insert({
    conversa_id: conversa.id,
    remetente: 'super_admin',
    super_admin_id: req.superAdmin.id,
    texto: req.body.texto
  });
  if (error) return res.status(500).json({ error: 'Erro ao enviar mensagem.' });

  // Garante que a conversa fica marcada como escalada (pode ter sido aberta pelo admin absoluto
  // respondendo direto sem o admin da empresa ter clicado em "Falar com o time" — não deveria
  // acontecer no fluxo normal, mas evita a mensagem ficar "perdida" numa conversa ainda em 'ia').
  await supabase.from('suporte_conversas').update({ status: 'aguardando_humano', atualizado_em: new Date().toISOString() }).eq('id', conversa.id);

  res.json({ success: true });
});

router.post('/super-admin/suporte/:id/resolver', async (req, res) => {
  const { data, error } = await supabase
    .from('suporte_conversas')
    .update({ status: 'resolvido', atualizado_em: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('id');

  if (error) return res.status(500).json({ error: 'Erro ao encerrar a conversa.' });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Conversa não encontrada.' });
  res.json({ success: true });
});

module.exports = router;
