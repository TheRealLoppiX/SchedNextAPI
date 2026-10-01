-- Plano exclusivo de uma empresa (ver routes/superAdminPlataforma.js, "Plano exclusivo"): o
-- admin absoluto monta um plano com todas as regras de um plano normal (preço, limites, recursos,
-- taxa, dias de teste) e campanha de preço por ciclo própria, que só essa empresa enxerga e
-- contrata (tela Conta dela). Fica fora do site (/planos-plataforma filtra) mesmo se alguém
-- marcar "visível no site" no editor geral de planos.
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

ALTER TABLE planos_plataforma ADD COLUMN IF NOT EXISTS empresa_exclusiva_id bigint REFERENCES empresas(id) ON DELETE CASCADE;

-- Um plano exclusivo por empresa: editar reaproveita a mesma linha.
CREATE UNIQUE INDEX IF NOT EXISTS planos_plataforma_empresa_exclusiva_unique
  ON planos_plataforma (empresa_exclusiva_id) WHERE empresa_exclusiva_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
