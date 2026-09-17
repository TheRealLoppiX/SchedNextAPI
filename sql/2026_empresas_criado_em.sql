-- Painel do admin absoluto (tela "Empresas") precisa saber quando cada empresa foi
-- cadastrada, mas a tabela empresas nunca teve essa coluna (id SERIAL era usado como
-- aproximação de ordem de cadastro, sem data de verdade — ver routes/superAdminPlataforma.js).
--
-- DEFAULT now() só vale para inserts futuros; ao rodar este ALTER, o Postgres aplica o
-- default também nas linhas já existentes, então empresas cadastradas antes desta migration
-- ficam com criado_em = data em que este script rodou (aproximação aceitável, sem forma de
-- recuperar a data real de cadastro delas).
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner).

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS criado_em timestamptz NOT NULL DEFAULT now();
