const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { planoPlataformaSchema } = require('../schemas');

const router = express.Router();

// --- Planos da plataforma (Grátis/Essencial/Profissional/Enterprise etc.) ---
// Antes desta rota, a única forma de mudar preço/limite/flag de um plano era escrever direto
// no banco pelo painel do Supabase — nenhuma rota do backend tocava planos_plataforma.

router.get('/super-admin/planos', async (req, res) => {
  const { data, error } = await supabase.from('planos_plataforma').select('*').order('preco_mensal', { ascending: true, nullsFirst: false });
  if (error) return res.status(500).json({ error: 'Erro ao buscar planos.' });
  res.json(data);
});

router.post('/super-admin/planos', validate(planoPlataformaSchema), async (req, res) => {
  const { data, error } = await supabase.from('planos_plataforma').insert(req.body).select('*').single();
  if (error) return res.status(500).json({ error: 'Erro ao criar plano.' });
  res.status(201).json(data);
});

router.put('/super-admin/planos/:id', validate(planoPlataformaSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('planos_plataforma')
    .update(req.body)
    .eq('id', req.params.id)
    .select('*')
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao atualizar plano.' });
  if (!data) return res.status(404).json({ error: 'Plano não encontrado.' });
  res.json(data);
});

// --- Empresas cadastradas na plataforma ---
// empresas não tem coluna de data de cadastro (ver PENDENCIAS.md), então a listagem usa id
// decrescente como aproximação de "mais recentes primeiro" (id é SERIAL, sempre crescente).

router.get('/super-admin/empresas', async (req, res) => {
  const { busca, status, plano_id } = req.query;

  let query = supabase
    .from('empresas')
    .select('id, nome, slug, email, vertical, status_assinatura, plano_plataforma_id, plano_plataforma:plano_plataforma_id(nome, preco_mensal)')
    .order('id', { ascending: false });

  // Remove vírgula/parênteses antes de interpolar no `.or()`: o PostgREST separa condições por
  // vírgula, então um valor como "x,plano_plataforma_id.eq.1" injetaria uma cláusula extra no filtro.
  if (busca) {
    const buscaSegura = String(busca).replace(/[,()]/g, '');
    query = query.or(`nome.ilike.%${buscaSegura}%,slug.ilike.%${buscaSegura}%,email.ilike.%${buscaSegura}%`);
  }
  if (status) query = query.eq('status_assinatura', status);
  if (plano_id) query = query.eq('plano_plataforma_id', plano_id);

  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: 'Erro ao buscar empresas.' });
  res.json(data);
});

router.post('/super-admin/empresas/:id/suspender', async (req, res) => {
  const { error } = await supabase.from('empresas').update({ status_assinatura: 'suspensa' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao suspender empresa.' });
  res.json({ success: true, message: 'Empresa suspensa. O login do admin dela fica bloqueado até reativar.' });
});

router.post('/super-admin/empresas/:id/reativar', async (req, res) => {
  const { error } = await supabase.from('empresas').update({ status_assinatura: 'ativa' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao reativar empresa.' });
  res.json({ success: true, message: 'Empresa reativada.' });
});

// --- Métricas gerais da plataforma ---

router.get('/super-admin/metricas', async (req, res) => {
  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('status_assinatura, plano_plataforma:plano_plataforma_id(nome, preco_mensal)');

  if (error) return res.status(500).json({ error: 'Erro ao calcular métricas.' });

  const totalEmpresas = empresas.length;
  const porStatus = {};
  const porPlano = {};
  let mrr = 0;

  for (const e of empresas) {
    porStatus[e.status_assinatura || 'sem_status'] = (porStatus[e.status_assinatura || 'sem_status'] || 0) + 1;

    const nomePlano = e.plano_plataforma?.nome || 'Sem plano';
    porPlano[nomePlano] = (porPlano[nomePlano] || 0) + 1;

    // MRR só soma empresas com assinatura ativa e plano pago — trial/inadimplente/suspensa não
    // representam receita recorrente confirmada.
    if (e.status_assinatura === 'ativa' && e.plano_plataforma?.preco_mensal > 0) {
      mrr += Number(e.plano_plataforma.preco_mensal);
    }
  }

  res.json({
    total_empresas: totalEmpresas,
    mrr: Number(mrr.toFixed(2)),
    empresas_por_status: porStatus,
    empresas_por_plano: porPlano
  });
});

module.exports = router;
