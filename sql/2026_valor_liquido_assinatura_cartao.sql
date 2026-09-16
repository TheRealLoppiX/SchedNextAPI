-- Valor líquido real (após taxa de processamento do Mercado Pago) da cobrança de mensalidade
-- de cliente final — cartão via preapproval (services/cobrancaAssinatura.js
-- buscarValorLiquidoCicloCartao) OU Pix (routes/mercadopago.js, confirmação do QR Code da
-- mensalidade). Fica NULL quando ainda não foi possível confirmar a taxa real (linha antiga,
-- baixa manual, ou falha pontual da API do Mercado Pago) — nesses casos o relatório
-- (routes/relatorios.js) cai pro cálculo por percentual cadastrado em empresas.taxas_pagamento,
-- igual já fazia antes desta coluna existir.
ALTER TABLE assinatura_cobrancas
  ADD COLUMN IF NOT EXISTS valor_liquido numeric(10,2) NULL;
