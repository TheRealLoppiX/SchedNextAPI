-- Cobrança recorrente da assinatura do CLIENTE FINAL (mensalidade que ele paga pra própria
-- barbearia — ver routes/mercadopago.js "Assinatura do cliente final"). Até aqui `assinante`
-- (usuarios) era um boolean só: "tem plano" e "está em dia" eram a mesma coisa. Agora viram
-- conceitos separados — status_assinatura controla se o BENEFÍCIO do plano (preço/cota) está
-- valendo, sem mexer no vínculo do plano em si.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna nova depois disso precisa de um arquivo novo, não editar
-- este.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS status_assinatura text NOT NULL DEFAULT 'em_dia'; -- 'em_dia' | 'inadimplente'

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS assinatura_forma_pagamento text NULL; -- 'cartao' | 'pix' | null (sem cobrança automática configurada)

-- Um registro por ciclo de cobrança do cliente (ciclo_ref = mesma âncora rolante de
-- assinatura_uso_mensal.ciclo_ref, dia-do-mês em que ele virou assinante). UNIQUE(usuario_id,
-- ciclo_ref) garante que o cron nunca gera cobrança duplicada pro mesmo ciclo mesmo rodando
-- todo dia.
CREATE TABLE IF NOT EXISTS assinatura_cobrancas (
  id serial PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  empresa_id integer NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  plano_id integer NULL REFERENCES planos_assinatura(id),
  ciclo_ref date NOT NULL,
  valor numeric(10,2) NOT NULL,
  forma_pagamento text NOT NULL,           -- 'cartao' | 'pix' | 'dinheiro' | 'outro'
  status text NOT NULL DEFAULT 'pendente', -- 'pendente' | 'pago' | 'falhou'
  mercadopago_payment_id text NULL,
  baixado_manualmente boolean NOT NULL DEFAULT false,
  observacoes text NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  pago_em timestamptz NULL,
  UNIQUE (usuario_id, ciclo_ref)
);

-- Só o backend (service_role, que ignora RLS) acessa esta tabela; sem policy = trancada pra
-- anon/authenticated, mesmo modelo de isolamento das demais tabelas novas do projeto.
ALTER TABLE assinatura_cobrancas ENABLE ROW LEVEL SECURITY;
