-- Cobrança de verdade em cima de contas_receber (ver sql/2026_contas_pagar_receber.sql):
-- geração de boleto via Mercado Pago (conta PRÓPRIA da plataforma, mesmo token de
-- MERCADOPAGO_PLATAFORMA_ACCESS_TOKEN já usado pra assinatura das empresas, ver
-- services/pagamento.js) e envio da cobrança por e-mail (ver routes/superAdminFinanceiro.js).
--
-- pagador_* cobre os dados de identificação/endereço que a API de boleto do Mercado Pago exige
-- do pagador (CPF/CNPJ + endereço completo) — sem isso a emissão do boleto é recusada pelo
-- gateway. mercadopago_payment_id é a chave que o webhook (routes/mercadopago.js) usa pra
-- reconciliar o pagamento e marcar a conta como recebida automaticamente, mesmo princípio já
-- usado pra agendamentos/assinatura_cobrancas.
--
-- Nota fiscal (NF-e/NFS-e) fica de fora por enquanto — exige contratar um provedor externo
-- (Focus NFe, eNotas, NFe.io etc.), decisão de negócio ainda em aberto.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna nova depois disso precisa de um arquivo novo, não editar
-- este nem os outros de contas_receber.

ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_email text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_documento text NULL; -- CPF ou CNPJ, só dígitos
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_cep text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_endereco text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_numero text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_bairro text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_cidade text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS pagador_uf text NULL;

ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS mercadopago_payment_id text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS boleto_url text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS boleto_codigo_barras text NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS boleto_gerado_em timestamptz NULL;
ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS cobranca_enviada_em timestamptz NULL;

CREATE INDEX IF NOT EXISTS contas_receber_mercadopago_payment_id_idx ON contas_receber (mercadopago_payment_id);
