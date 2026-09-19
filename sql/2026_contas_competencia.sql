-- Competência (mês/ano de referência financeira, regime de competência) das contas a
-- pagar/receber da plataforma (ver sql/2026_contas_pagar_receber.sql). Separado da data de
-- vencimento/pagamento (regime de caixa) — ex: aluguel de setembro pago em outubro tem
-- competencia = 2026-09-01 e data_pagamento em outubro. Guardado como DATE no dia 1 do mês
-- (nunca outro dia), pra dar pra indexar/filtrar por mês igual as demais colunas DATE do
-- projeto, com o "dia" apenas como convenção de armazenamento.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna nova depois disso precisa de um arquivo novo, não editar
-- este nem 2026_contas_pagar_receber.sql.

ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS competencia date NULL;
UPDATE contas_pagar SET competencia = date_trunc('month', data_vencimento)::date WHERE competencia IS NULL;
ALTER TABLE contas_pagar ALTER COLUMN competencia SET NOT NULL;

ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS competencia date NULL;
UPDATE contas_receber SET competencia = date_trunc('month', data_prevista)::date WHERE competencia IS NULL;
ALTER TABLE contas_receber ALTER COLUMN competencia SET NOT NULL;

CREATE INDEX IF NOT EXISTS contas_pagar_competencia_idx ON contas_pagar (competencia);
CREATE INDEX IF NOT EXISTS contas_receber_competencia_idx ON contas_receber (competencia);
