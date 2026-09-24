const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { suporteMensagemSchema, suporteRepassarSchema } = require('../schemas');
const { nomeDoEmail } = require('../utils/nomeAdmin');

const router = express.Router();

// Lado do admin absoluto do módulo de suporte (ver routes/suporte.js pro lado da empresa).
//
// Exclusividade de atendimento: quando um super admin "aceita" um caso escalado (ou manda a
// primeira mensagem nele — aceitar automaticamente), a conversa fica travada pra ele: nenhum
// outro super admin consegue mandar mensagem até o caso ser repassado (ver /repassar abaixo).
// Antes disso, qualquer super admin logado podia responder qualquer conversa ao mesmo tempo,
// sem trava nenhuma — dois admins podiam se atropelar respondendo a mesma coisa.
function mapConversa(c) {
  return {
    id: c.id,
    empresa_id: c.empresa_id,
    nome_empresa: c.empresas?.nome || 'Empresa',
    slug_empresa: c.empresas?.slug || null,
    status: c.status,
    criado_em: c.criado_em,
    atualizado_em: c.atualizado_em,
    atendido_por_super_admin_id: c.atendido_por_super_admin_id || null,
    atendido_por_nome: c.atendido_por?.email ? nomeDoEmail(c.atendido_por.email) : null
  };
}

router.get('/super-admin/suporte', async (req, res) => {
  const { data, error } = await supabase
    .from('suporte_conversas')
    .select('id, empresa_id, status, criado_em, atualizado_em, atendido_por_super_admin_id, empresas(nome, slug), atendido_por:atendido_por_super_admin_id(email)')
    .neq('status', 'ia') // conversas ainda só com a IA (não escaladas) não interessam aqui
    .order('atualizado_em', { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: 'Erro ao listar conversas de suporte.' });
  res.json((data || []).map(mapConversa));
});

// Liga/desliga o aviso de "repassado pra você" (ver sql/2026_suporte_repasse_pendente.sql).
// Separado do update principal de propósito: se a coluna ainda não existir no banco (SQL não
// rodado), o aceitar/repassar/responder continua funcionando, só sem esse aviso.
async function marcarRepassePendente(conversaId, pendente) {
  const { error } = await supabase.from('suporte_conversas').update({ repasse_pendente: pendente }).eq('id', conversaId);
  if (error) console.error('[suporte] erro ao marcar repasse_pendente:', error.message);
}

// Pendências do super admin logado, pro balão com contador no menu e o aviso na tela (o front
// consulta isso a cada poucos segundos): conversas escaladas sem ninguém atendendo + as
// repassadas pra ele que ele ainda não aceitou/respondeu. Registrada antes de /:id pra
// "pendencias" não ser lido como id.
router.get('/super-admin/suporte/pendencias', async (req, res) => {
  const meuId = req.superAdmin.id;
  const colunas = 'id, atualizado_em, atendido_por_super_admin_id, empresas(nome)';
  const { data: semAtendente, error } = await supabase
    .from('suporte_conversas')
    .select(colunas)
    .eq('status', 'aguardando_humano')
    .is('atendido_por_super_admin_id', null);
  if (error) return res.status(500).json({ error: 'Erro ao carregar pendências de suporte.' });

  const { data: repassadas, error: erroRepasse } = await supabase
    .from('suporte_conversas')
    .select(colunas)
    .eq('status', 'aguardando_humano')
    .eq('atendido_por_super_admin_id', meuId)
    .eq('repasse_pendente', true);
  if (erroRepasse) console.error('[suporte] pendências de repasse indisponíveis:', erroRepasse.message);

  const mapear = (motivo) => (c) => ({ id: c.id, nome_empresa: c.empresas?.nome || 'Empresa', motivo, atualizado_em: c.atualizado_em });
  res.json([
    ...(semAtendente || []).map(mapear('sem_atendente')),
    ...(repassadas || []).map(mapear('repassada_para_voce'))
  ]);
});

router.get('/super-admin/suporte/:id', async (req, res) => {
  const { data: conversa, error: erroConversa } = await supabase
    .from('suporte_conversas')
    .select('id, empresa_id, status, criado_em, atualizado_em, atendido_por_super_admin_id, empresas(nome, slug), atendido_por:atendido_por_super_admin_id(email)')
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
    conversa: mapConversa(conversa),
    mensagens: (mensagens || []).map((m) => ({ ...m, nome_admin: m.super_admin?.email ? nomeDoEmail(m.super_admin.email) : null })),
    // Pra montar o seletor de "repassar pra quem" no front sem uma segunda chamada.
    voceMesmoId: req.superAdmin.id
  });
});

// Reivindica o caso pra si. Idempotente se já for você; recusa se já estiver com outro admin
// (nesse caso o caminho é /repassar, não /aceitar).
router.post('/super-admin/suporte/:id/aceitar', async (req, res) => {
  const { data: conversa } = await supabase.from('suporte_conversas').select('id, atendido_por_super_admin_id').eq('id', req.params.id).maybeSingle();
  if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });

  if (conversa.atendido_por_super_admin_id && conversa.atendido_por_super_admin_id !== req.superAdmin.id) {
    return res.status(409).json({ error: 'Este caso já está sendo atendido por outro admin.' });
  }

  const { error } = await supabase
    .from('suporte_conversas')
    .update({ atendido_por_super_admin_id: req.superAdmin.id, atualizado_em: new Date().toISOString() })
    .eq('id', conversa.id);
  if (error) return res.status(500).json({ error: 'Erro ao aceitar o caso.' });
  await marcarRepassePendente(conversa.id, false);
  res.json({ success: true });
});

// Passa o caso pra outro super admin (ou libera, com super_admin_id null) — qualquer super admin
// pode repassar, não só quem está atendendo agora, pelo mesmo motivo de qualquer super admin já
// poder criar/editar outro (autoridade equivalente entre donos da plataforma).
router.post('/super-admin/suporte/:id/repassar', validate(suporteRepassarSchema), async (req, res) => {
  const { data: conversa } = await supabase.from('suporte_conversas').select('id').eq('id', req.params.id).maybeSingle();
  if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });

  if (req.body.super_admin_id) {
    const { data: destino } = await supabase.from('super_admins').select('id').eq('id', req.body.super_admin_id).eq('ativo', true).maybeSingle();
    if (!destino) return res.status(400).json({ error: 'Super admin de destino inválido.' });
  }

  const { error } = await supabase
    .from('suporte_conversas')
    .update({ atendido_por_super_admin_id: req.body.super_admin_id || null, atualizado_em: new Date().toISOString() })
    .eq('id', conversa.id);
  if (error) return res.status(500).json({ error: 'Erro ao repassar o caso.' });
  // Repassou pra outra pessoa: ela recebe o aviso até aceitar/responder. Liberado (null) já
  // volta a contar como "sem atendente" pra todo mundo, sem precisar do flag.
  await marcarRepassePendente(conversa.id, Boolean(req.body.super_admin_id && req.body.super_admin_id !== req.superAdmin.id));
  res.json({ success: true });
});

// Só quem está atendendo o caso (atendido_por_super_admin_id) pode mandar mensagem nele — se
// ainda não tem ninguém atendendo, a primeira mensagem já reivindica o caso pra quem mandou
// (responder = aceitar), sem precisar clicar em "Aceitar" antes.
router.post('/super-admin/suporte/:id/mensagem', validate(suporteMensagemSchema), async (req, res) => {
  const { data: conversa } = await supabase.from('suporte_conversas').select('id, status, atendido_por_super_admin_id').eq('id', req.params.id).maybeSingle();
  if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });

  if (conversa.atendido_por_super_admin_id && conversa.atendido_por_super_admin_id !== req.superAdmin.id) {
    return res.status(403).json({ error: 'Este caso está sendo atendido por outro admin. Peça pra repassar pra você antes de responder.' });
  }

  const { error } = await supabase.from('suporte_mensagens').insert({
    conversa_id: conversa.id,
    remetente: 'super_admin',
    super_admin_id: req.superAdmin.id,
    texto: req.body.texto
  });
  if (error) return res.status(500).json({ error: 'Erro ao enviar mensagem.' });

  // Garante que a conversa fica marcada como escalada e atendida por quem respondeu — cobre o
  // caso de responder sem ter clicado em "Aceitar" antes (aceitação implícita pela resposta), e
  // também empresas que ainda estivessem em status 'ia' por algum motivo.
  await supabase
    .from('suporte_conversas')
    .update({ status: 'aguardando_humano', atendido_por_super_admin_id: req.superAdmin.id, atualizado_em: new Date().toISOString() })
    .eq('id', conversa.id);
  await marcarRepassePendente(conversa.id, false);

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
