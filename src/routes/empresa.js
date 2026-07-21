const express = require('express');
const supabase = require('../config/supabase');
const { obterSlugTenant, resolverEmpresaPorSlug } = require('../utils/tenantContext');

const router = express.Router();

router.get('/admin/empresa/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, nome, slug, logo_url, vertical, cor_principal, cor_destaque, status_assinatura, proxima_cobranca_em, cancelamento_agendado, plano_plataforma_id, plano_plataforma:plano_plataforma_id(id, nome, preco_mensal, permite_paleta_customizada, permite_whatsapp_bot, permite_remover_marca, permite_ia)')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json(error);
  res.json(data);
});

// ROTA PARA ATUALIZAR DADOS DA EMPRESA
router.put('/admin/empresa/atualizar', async (req, res) => {
  const { id, nome, logo_url, horarios, cor_principal, cor_destaque } = req.body;

  // Converte o objeto de horários para texto (JSON) para salvar no banco
  const horariosStr = horarios ? JSON.stringify(horarios) : null;
  const atualizacao = { nome, logo_url, horarios_funcionamento: horariosStr };

  // Paleta de cores customizada é recurso do plano Essencial+ (ver §7 do plano de
  // plataforma) — plano Grátis mantém a paleta padrão da plataforma mesmo se enviar cor.
  if (cor_principal !== undefined || cor_destaque !== undefined) {
    const { data: empresaAtual } = await supabase
      .from('empresas')
      .select('plano_plataforma:plano_plataforma_id(permite_paleta_customizada)')
      .eq('id', id)
      .maybeSingle();

    if (empresaAtual?.plano_plataforma?.permite_paleta_customizada) {
      if (cor_principal !== undefined) atualizacao.cor_principal = cor_principal;
      if (cor_destaque !== undefined) atualizacao.cor_destaque = cor_destaque;
    }
  }

  const { error } = await supabase
    .from('empresas')
    .update(atualizacao)
    .eq('id', id);

  if (error) {
    console.error('Erro ao atualizar banco:', error);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }
  res.json({ message: 'Dados atualizados com sucesso!' });
});

router.get('/empresa/slug/:slug', async (req, res) => {
  const slug = obterSlugTenant(req);
  const { empresa: data, error } = await resolverEmpresaPorSlug(
    slug,
    'nome, logo_url, vertical, cor_principal, cor_destaque, plano_plataforma:plano_plataforma_id(nome, permite_paleta_customizada, permite_whatsapp_bot, permite_remover_marca)'
  );

  if (error) return res.status(500).json(error);
  if (!data) return res.status(404).json({ message: 'Empresa não encontrada' });
  res.json(data);
});

router.put('/admin/config-empresa', async (req, res) => {
  const { id, nome_fantasia, logo_url, cor_primary } = req.body;

  // Bug pré-existente corrigido aqui: a coluna real no banco é `cor_principal`, não
  // `cor_primary` (ver database-schema.md) — a query original apontava para uma coluna
  // inexistente e derrubava a rota em toda chamada.
  const { error } = await supabase
    .from('empresas')
    .update({ nome_fantasia, logo_url, cor_principal: cor_primary })
    .eq('id', id);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
  res.json({ success: true, message: 'Perfil atualizado!' });
});

module.exports = router;
