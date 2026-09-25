const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { acaoFidelidadeSchema, acaoStatusSchema } = require('../schemas');
const { notificarNovaCampanhaFidelidade } = require('../services/fidelidade');

const router = express.Router();

router.get('/admin/acoes/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('campanhas_fidelidade')
    .select('*')
    .eq('empresa_id', req.empresaId)
    .order('data_fim', { ascending: false });

  if (error) return res.status(500).json(error);
  res.json(data);
});

router.post('/admin/acoes', validate(acaoFidelidadeSchema), async (req, res) => {
  const { nome, data_inicio, data_fim, cortes_necessarios, valor_minimo, premio_descritivo, tipo_premio, premio_servico_id, premio_produto_id, premio_valor } = req.body;
  const empresa_id = req.empresaId;

  // Prêmio estruturado (aplicado sozinho no caixa, ver services/fidelidade.js): o serviço/produto
  // escolhido tem que ser desta empresa, e cada tipo só guarda o campo que usa.
  const tipo = tipo_premio || 'servico';
  const premio = { premio_servico_id: null, premio_produto_id: null, premio_valor: null };
  if (tipo === 'servico' && premio_servico_id) {
    const { data: serv } = await supabase.from('servicos').select('id').eq('id', premio_servico_id).eq('empresa_id', empresa_id).maybeSingle();
    if (!serv) return res.status(400).json({ error: 'Serviço do prêmio não encontrado.' });
    premio.premio_servico_id = serv.id;
  }
  if (tipo === 'produto' && premio_produto_id) {
    const { data: prod } = await supabase.from('produtos').select('id').eq('id', premio_produto_id).eq('empresa_id', empresa_id).maybeSingle();
    if (!prod) return res.status(400).json({ error: 'Produto do prêmio não encontrado.' });
    premio.premio_produto_id = prod.id;
  }
  if ((tipo === 'desconto_percentual' || tipo === 'desconto_valor') && premio_valor) premio.premio_valor = premio_valor;

  // Desativa as outras para garantir que só 1 fique ativa por vez ao criar uma nova
  await supabase.from('campanhas_fidelidade').update({ ativa: false }).eq('empresa_id', empresa_id);

  const { data: novaCampanha, error } = await supabase.from('campanhas_fidelidade').insert({
    empresa_id,
    nome,
    data_inicio,
    data_fim,
    cortes_necessarios,
    valor_minimo,
    premio_descritivo,
    tipo_premio: tipo,
    ...premio,
    ativa: true
  }).select('*').single();

  if (error) return res.status(500).json(error);

  // Fire-and-forget de propósito (ver services/fidelidade.js) — não faz sentido o admin esperar
  // o envio de e-mail/WhatsApp pra cada cliente antes de ver a campanha criada.
  notificarNovaCampanhaFidelidade(empresa_id, novaCampanha).catch((err) => {
    console.error('Erro ao disparar notificação de nova campanha de fidelidade:', err);
  });

  res.json({ message: 'Ação criada e ativada com sucesso!' });
});

router.put('/admin/acoes/:id/status', validate(acaoStatusSchema), async (req, res) => {
  const { id } = req.params;
  const { ativar } = req.body;
  const empresa_id = req.empresaId;

  const { data: campanha } = await supabase.from('campanhas_fidelidade').select('empresa_id').eq('id', id).maybeSingle();
  if (!campanha || campanha.empresa_id !== empresa_id) return res.status(404).json({ error: 'Ação não encontrada.' });

  if (ativar) {
    // Se for ativar, desativa todas as outras primeiro
    await supabase.from('campanhas_fidelidade').update({ ativa: false }).eq('empresa_id', empresa_id);
    await supabase.from('campanhas_fidelidade').update({ ativa: true }).eq('id', id);
    return res.json({ message: 'Ativada!' });
  }

  await supabase.from('campanhas_fidelidade').update({ ativa: false }).eq('id', id);
  res.json({ message: 'Desativada!' });
});

router.delete('/admin/acoes/:id', async (req, res) => {
  const { data: campanha } = await supabase.from('campanhas_fidelidade').select('empresa_id').eq('id', req.params.id).maybeSingle();
  if (!campanha || campanha.empresa_id !== req.empresaId) return res.status(404).json({ error: 'Ação não encontrada.' });

  const { error } = await supabase.from('campanhas_fidelidade').delete().eq('id', req.params.id);
  if (error) return res.status(500).json(error);
  res.json({ message: 'Ação excluída!' });
});

module.exports = router;
