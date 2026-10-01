-- Estoque separado em produtos de VENDA (aparecem no caixa) e de USO do estabelecimento
-- (consumo interno, nunca vendidos), código de barras por produto, custo de compra opcional e
-- registro de cada venda com preço e custo do momento, pra relatório de gastos e de receita
-- líquida por produto (ver routes/estoque.js e routes/agendamentos.js, checkout).
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

-- 1) Produtos: tipo, código de barras e custo unitário da última compra.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'venda';
ALTER TABLE produtos DROP CONSTRAINT IF EXISTS produtos_tipo_check;
ALTER TABLE produtos ADD CONSTRAINT produtos_tipo_check CHECK (tipo IN ('venda', 'uso'));
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_barras text;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo numeric(10,2);
-- Produto de uso não tem preço de venda.
ALTER TABLE produtos ALTER COLUMN valor DROP NOT NULL;

-- Mesmo código não pode existir duas vezes na mesma empresa (em empresas diferentes pode).
CREATE UNIQUE INDEX IF NOT EXISTS produtos_empresa_codigo_barras_unique
  ON produtos (empresa_id, codigo_barras) WHERE codigo_barras IS NOT NULL;

-- Produtos antigos ganham o código interno gerado pelo sistema (mesmo formato de
-- routes/estoque.js: EAN-13 começando com 200, faixa reservada pra uso interno).
UPDATE produtos p
SET codigo_barras = c.base || (
  (10 - (
    (substr(c.base,1,1)::int + substr(c.base,3,1)::int + substr(c.base,5,1)::int + substr(c.base,7,1)::int + substr(c.base,9,1)::int + substr(c.base,11,1)::int)
    + 3 * (substr(c.base,2,1)::int + substr(c.base,4,1)::int + substr(c.base,6,1)::int + substr(c.base,8,1)::int + substr(c.base,10,1)::int + substr(c.base,12,1)::int)
  ) % 10) % 10
)::text
FROM (SELECT id, '200' || lpad(id::text, 9, '0') AS base FROM produtos) c
WHERE p.id = c.id AND p.codigo_barras IS NULL;

-- 2) Movimentações: custo e data da compra (opcionais) nas entradas. A coluna tipo vira texto
-- livre com check próprio: o banco veio do MySQL com enum ADICIONAR/RETIRAR e o backend usa
-- REMOVER, os dois ficam aceitos.
ALTER TABLE estoque_movimentacoes ALTER COLUMN tipo TYPE text;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'estoque_movimentacoes'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%tipo%'
  LOOP
    EXECUTE format('ALTER TABLE estoque_movimentacoes DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE estoque_movimentacoes ADD CONSTRAINT estoque_movimentacoes_tipo_check
  CHECK (tipo IN ('ADICIONAR', 'REMOVER', 'RETIRAR', 'VENDA'));
ALTER TABLE estoque_movimentacoes ADD COLUMN IF NOT EXISTS custo_unitario numeric(10,2);
ALTER TABLE estoque_movimentacoes ADD COLUMN IF NOT EXISTS data_compra date;
ALTER TABLE estoque_movimentacoes ALTER COLUMN justificativa DROP NOT NULL;

-- 3) Vendas de produto no caixa, com preço e custo congelados no momento da venda.
CREATE TABLE IF NOT EXISTS produto_vendas (
  id bigserial PRIMARY KEY,
  empresa_id bigint NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  produto_id bigint NOT NULL REFERENCES produtos(id),
  agendamento_id bigint REFERENCES agendamentos(id) ON DELETE SET NULL,
  quantidade int NOT NULL CHECK (quantidade > 0),
  preco_unitario numeric(10,2) NOT NULL,
  custo_unitario numeric(10,2),
  vendido_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE produto_vendas ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS produto_vendas_empresa_data_idx ON produto_vendas (empresa_id, vendido_em);

-- 4) Relatório de receita líquida por produto: recurso de plano, ligado do Profissional pra cima
-- (editável depois no admin absoluto, em Planos).
ALTER TABLE planos_plataforma ADD COLUMN IF NOT EXISTS permite_relatorio_produtos boolean NOT NULL DEFAULT false;
UPDATE planos_plataforma SET permite_relatorio_produtos = true
WHERE preco_mensal IS NULL
   OR preco_mensal >= (SELECT min(preco_mensal) FROM planos_plataforma WHERE nome ILIKE 'Profissional%');
