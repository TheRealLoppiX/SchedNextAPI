const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { cancelarAssinaturaNoGateway } = require('../services/pagamento');
const { planoPlataformaSchema, empresaVencimentoSchema, empresaTrocarPlanoSchema } = require('../schemas');

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
// criado_em existe desde sql/2026_empresas_criado_em.sql — empresas cadastradas antes dessa
// migration ficaram com a data em que ela rodou (não dá pra recuperar a data real delas).

router.get('/super-admin/empresas', async (req, res) => {
  const { busca, status, plano_id } = req.query;

  let query = supabase
    .from('empresas')
    .select(`
      id, nome, slug, email, vertical, criado_em,
      status_assinatura, proxima_cobranca_em, cancelamento_agendado, chave_ativacao_expira_em,
      plano_plataforma_id, plano_plataforma:plano_plataforma_id(nome, preco_mensal, limite_profissionais, limite_agendamentos_mes),
      plano_plataforma_pendente_id, plano_plataforma_pendente:plano_plataforma_pendente_id(nome, preco_mensal)
    `)
    .order('criado_em', { ascending: false });

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

// Detalhamento completo de uma empresa (aba "Empresas" -> "Ver detalhes"): junta os dados já
// usados na listagem com o consumo atual de barbeiros/agendamentos contra o limite do plano
// (mesma lógica de utils/limitesPlano.js, mas com o número, não só true/false) — calcular isso
// pra cada linha da listagem faria 2 queries extras por empresa, então fica só nesta rota,
// aberta sob demanda.
router.get('/super-admin/empresas/:id', async (req, res) => {
  const { data: empresa, error } = await supabase
    .from('empresas')
    .select(`
      id, nome, slug, email, vertical, cpf_cnpj, criado_em,
      status_assinatura, proxima_cobranca_em, cancelamento_agendado, gateway_subscription_id,
      chave_ativacao_expira_em, dominio_customizado, dominio_verificado,
      plano_plataforma_id, plano_plataforma:plano_plataforma_id(nome, preco_mensal, limite_profissionais, limite_agendamentos_mes, limite_admins),
      plano_plataforma_pendente_id, plano_plataforma_pendente:plano_plataforma_pendente_id(nome, preco_mensal)
    `)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar empresa.' });
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  const inicioMes = new Date();
  inicioMes.setUTCDate(1);
  const inicioMesISO = inicioMes.toISOString().slice(0, 10);

  const [{ count: totalBarbeiros }, { count: totalAgendamentosMes }, { count: totalClientes }, { count: totalUnidades }] = await Promise.all([
    supabase.from('barbeiros').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id),
    supabase.from('agendamentos').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id).gte('data_hora', `${inicioMesISO}T00:00:00`).neq('status', 'cancelado'),
    supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id),
    supabase.from('unidades').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id)
  ]);

  res.json({
    ...empresa,
    uso: {
      barbeiros: totalBarbeiros || 0,
      agendamentos_mes: totalAgendamentosMes || 0,
      clientes: totalClientes || 0,
      unidades: totalUnidades || 0
    }
  });
});

// Ajusta manualmente a data de próxima cobrança da assinatura da PLATAFORMA (dar carência,
// corrigir uma data errada, etc.) — não mexe em status_assinatura nem em cancelamento_agendado,
// só na data em si.
router.put('/super-admin/empresas/:id/vencimento', validate(empresaVencimentoSchema), async (req, res) => {
  const { error } = await supabase
    .from('empresas')
    .update({ proxima_cobranca_em: req.body.proxima_cobranca_em })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao atualizar a data de cobrança.' });
  res.json({ success: true, message: 'Data de próxima cobrança atualizada.' });
});

// Troca o plano da empresa na marra (suporte: cortesia, correção de um webhook que não aplicou o
// plano pendente, negociação fechada fora do sistema etc.) — mesma ideia de
// POST /super-admin/leads-enterprise/:id/ativar-empresa, mas pra qualquer plano, não só
// Enterprise. Cancela uma assinatura recorrente existente no Mercado Pago antes de trocar (best
// effort): sem isso, o cliente continuaria sendo cobrado no plano ANTIGO por uma recorrência que
// o admin não sabe mais que existe, já que o gateway_subscription_id é zerado a seguir.
router.put('/super-admin/empresas/:id/plano', validate(empresaTrocarPlanoSchema), async (req, res) => {
  const { data: plano } = await supabase.from('planos_plataforma').select('id').eq('id', req.body.plano_plataforma_id).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  const { data: empresaAtual } = await supabase.from('empresas').select('gateway_subscription_id').eq('id', req.params.id).maybeSingle();
  if (!empresaAtual) return res.status(404).json({ error: 'Empresa não encontrada.' });

  if (empresaAtual.gateway_subscription_id) {
    try {
      await cancelarAssinaturaNoGateway(empresaAtual.gateway_subscription_id);
    } catch (e) {
      console.error('Erro ao cancelar assinatura anterior no Mercado Pago (troca manual de plano pelo admin absoluto):', e);
    }
  }

  const { error } = await supabase
    .from('empresas')
    .update({
      plano_plataforma_id: plano.id,
      plano_plataforma_pendente_id: null,
      gateway_subscription_id: null,
      status_assinatura: 'ativa',
      cancelamento_agendado: false
    })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao trocar o plano da empresa.' });
  res.json({ success: true, message: 'Plano da empresa atualizado. Se havia cobrança recorrente ativa, ela foi cancelada, ajuste a data de próxima cobrança se o novo plano também for pago.' });
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
