-- Pagamento dividido no checkout do PDV: o mesmo atendimento pode ser pago com mais de uma
-- forma (ex: R$30 no crédito + R$20 no Pix), cada perna com seu próprio valor, mantendo a lógica
-- de taxa de maquineta por forma de pagamento (ver taxas_pagamento em empresas) aplicada
-- individualmente a cada perna no cálculo de receita líquida (routes/relatorios.js).
--
-- forma_pagamento (coluna existente, singular) continua sendo usada quando só UMA forma foi
-- usada — comportamento e leitores antigos (routes/relatorios.js legado, exports) continuam
-- funcionando sem mudança nenhuma. formas_pagamento só é preenchida quando o atendimento foi
-- fechado com pagamento dividido (mais de uma perna).
--
-- Formato: array de {forma_pagamento: 'dinheiro'|'credito'|'debito'|'pix', valor: number,
-- mercadopago_payment_id?: string}. A perna 'pix' (se houver) referencia o MESMO pagamento real
-- gerado via /admin/mercadopago/pix/:id — mercadopago_payment_id nessa tabela já guarda esse id;
-- guardamos de novo dentro do JSON só pra rastreabilidade de qual perna corresponde à cobrança
-- real, sem precisar de coluna nova pra isso.
--
-- Rodado via Management API do Supabase, mesmo padrão do resto do projeto (sem migration
-- runner). Qualquer coluna nova depois disso precisa de um arquivo novo, não editar este.

ALTER TABLE agendamentos
  ADD COLUMN IF NOT EXISTS formas_pagamento jsonb NULL;
