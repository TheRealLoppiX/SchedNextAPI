const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { taxasPagamentoSchema } = require('../schemas');

const router = express.Router();

const TAXAS_PADRAO = { dinheiro: 0, credito: 0, debito: 0, pix: 0 };

// Taxas de maquineta por forma de pagamento — usadas pra calcular receita líquida nos
// Relatórios avançados e no relatório de comissionamento (ver routes/relatorios.js). Puramente
// informativo: não afeta o que é cobrado do cliente, só o cálculo de receita líquida do negócio.
router.get('/admin/taxas-pagamento/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('empresas')
    .select('taxas_pagamento')
    .eq('id', req.empresaId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar taxas de pagamento.' });
  res.json({ taxas_pagamento: { ...TAXAS_PADRAO, ...(data?.taxas_pagamento || {}) } });
});

router.put('/admin/taxas-pagamento', validate(taxasPagamentoSchema), async (req, res) => {
  const { error } = await supabase
    .from('empresas')
    .update({ taxas_pagamento: req.body.taxas_pagamento })
    .eq('id', req.empresaId);

  if (error) return res.status(500).json({ error: 'Erro ao salvar taxas de pagamento.' });
  res.json({ success: true });
});

module.exports = router;
