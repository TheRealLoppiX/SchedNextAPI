-- Valor líquido real (após taxa de processamento do Mercado Pago) de um Pix de atendimento
-- (PDV) pago com uma única forma de pagamento — ver reconfirmarPagamento em
-- routes/mercadopago.js. Mesmo princípio da coluna equivalente em assinatura_cobrancas
-- (sql/2026_valor_liquido_assinatura_cartao.sql): fica NULL quando não há dado real (linha
-- antiga, forma que não seja Pix, Pix registrado manualmente fora do gateway, ou falha pontual
-- da API do Mercado Pago), e o relatório (routes/relatorios.js) cai pro percentual cadastrado.
--
-- Pagamento dividido (formas_pagamento, ver sql/2026_split_pagamento.sql) não usa esta coluna —
-- a perna Pix carrega seu próprio `valor_liquido` dentro do próprio objeto JSON da perna,
-- gravado em routes/agendamentos.js:finalizar-servico-checkout.
ALTER TABLE agendamentos
  ADD COLUMN IF NOT EXISTS valor_liquido numeric(10,2) NULL;
