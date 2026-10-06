-- Saldos separados de revenda e de uso do estabelecimento pro mesmo produto (ver routes/estoque.js
-- e AdminEstoque.js): cada saldo é uma linha de produtos com o mesmo nome e o mesmo código de
-- barras, uma com tipo 'venda' e outra com tipo 'uso'. O código continua único dentro de cada tipo.
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

DROP INDEX IF EXISTS produtos_empresa_codigo_barras_unique;
CREATE UNIQUE INDEX produtos_empresa_codigo_barras_unique
  ON produtos (empresa_id, tipo, codigo_barras) WHERE codigo_barras IS NOT NULL AND excluido_em IS NULL;
