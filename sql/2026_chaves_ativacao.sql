-- Chaves de ativação de plano: super admin gera uma chave com validade (ex: "3 meses de
-- Profissional"), o admin da empresa resgata em Assinatura -> Ativar chave promocional.
-- Ver backend/src/routes/chavesAtivacao.js. Rodado via Management API do Supabase, mesmo
-- padrão do resto do projeto (sem migration runner). JÁ APLICADO EM PRODUÇÃO em 2026-08-20 —
-- não editar esse arquivo pra mudar o schema; qualquer coluna nova precisa de um arquivo novo.

CREATE TABLE IF NOT EXISTS chaves_ativacao (
  id serial PRIMARY KEY,
  codigo text NOT NULL UNIQUE,
  plano_plataforma_id integer NOT NULL REFERENCES planos_plataforma(id),
  duracao_dias integer NOT NULL CHECK (duracao_dias > 0),
  observacao text NULL,
  criado_por_super_admin_id uuid NULL REFERENCES super_admins(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  prazo_resgate_ate timestamptz NULL,   -- prazo pra resgatar a chave; NULL = sem prazo
  usada_em timestamptz NULL,
  usada_por_empresa_id integer NULL REFERENCES empresas(id),
  revogada_em timestamptz NULL
);

-- Só o backend (service_role, que ignora RLS) acessa esta tabela — mesmo padrão de isolamento
-- das demais tabelas novas do projeto (RLS ligada, sem nenhuma policy = deny total pra
-- anon/authenticated).
ALTER TABLE chaves_ativacao ENABLE ROW LEVEL SECURITY;

-- Quando o plano concedido por chave expira, o cron em src/cron/assinaturas.js derruba a
-- empresa pro Grátis (mesmo mecanismo do cancelamento agendado de cobrança).
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS chave_ativacao_expira_em timestamptz NULL;
