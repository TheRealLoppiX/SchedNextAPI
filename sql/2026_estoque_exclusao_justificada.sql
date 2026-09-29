-- Exclusão de produto do estoque vira arquivamento com justificativa (ver routes/estoque.js,
-- DELETE /admin/estoque/:id): o produto sai do estoque, do caixa e das buscas, mas a linha fica,
-- pra relatórios, vendas (produto_vendas) e histórico de movimentações continuarem mostrando o
-- nome dele. A exclusão entra no histórico como movimentação EXCLUSAO, com operador e motivo.
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS excluido_em timestamptz;

-- Código de barras de produto excluído fica livre pra um cadastro novo.
DROP INDEX IF EXISTS produtos_empresa_codigo_barras_unique;
CREATE UNIQUE INDEX produtos_empresa_codigo_barras_unique
  ON produtos (empresa_id, codigo_barras) WHERE codigo_barras IS NOT NULL AND excluido_em IS NULL;

ALTER TABLE estoque_movimentacoes DROP CONSTRAINT IF EXISTS estoque_movimentacoes_tipo_check;
ALTER TABLE estoque_movimentacoes ADD CONSTRAINT estoque_movimentacoes_tipo_check
  CHECK (tipo IN ('ADICIONAR', 'REMOVER', 'RETIRAR', 'VENDA', 'EXCLUSAO'));
