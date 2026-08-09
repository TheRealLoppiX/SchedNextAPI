-- Limite de agendamentos por servico dentro de um plano de assinatura.
-- Rodar manualmente no SQL editor do Supabase.

-- Dedup de plano_servicos antes de travar unicidade (historico nao tinha constraint).
DELETE FROM plano_servicos a USING plano_servicos b
  WHERE a.ctid < b.ctid AND a.plano_id = b.plano_id AND a.servico_id = b.servico_id;

ALTER TABLE plano_servicos
  ADD COLUMN IF NOT EXISTS limite_mensal integer NULL; -- NULL = ilimitado

ALTER TABLE plano_servicos
  ADD CONSTRAINT plano_servicos_plano_servico_unique UNIQUE (plano_id, servico_id);

CREATE TABLE IF NOT EXISTS assinatura_uso_mensal (
  id serial PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  servico_id integer NOT NULL REFERENCES servicos(id) ON DELETE CASCADE,
  ciclo_ref date NOT NULL,        -- data de inicio do ciclo rolante atual do cliente
  usados integer NOT NULL DEFAULT 0,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, servico_id, ciclo_ref)
);

-- So o backend (service_role, que ignora RLS) acessa esta tabela; sem policy = trancada
-- pra anon/authenticated, seguindo o mesmo modelo de isolamento das demais tabelas.
ALTER TABLE assinatura_uso_mensal ENABLE ROW LEVEL SECURITY;
