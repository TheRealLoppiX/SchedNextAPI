-- Prêmio estruturado nas ações de fidelidade + registro de resgate (cortesia no caixa).
--
-- Antes o prêmio era só um texto (premio_descritivo) e o sistema só avisava o cliente que ele
-- bateu a meta. Agora a ação guarda QUAL é o prêmio, pra ser aplicado sozinho no fechamento de
-- caixa do próximo atendimento:
--   tipo_premio = 'servico'             -> premio_servico_id sai de graça
--   tipo_premio = 'produto'             -> 1 unidade de premio_produto_id sai de graça
--   tipo_premio = 'desconto_percentual' -> premio_valor % sobre o atendimento inteiro
--   tipo_premio = 'desconto_valor'      -> premio_valor em R$ sobre o atendimento inteiro
-- Ações antigas (tipo nulo/'desconto' sem valor) continuam funcionando: o caixa mostra o texto
-- do prêmio e só registra a entrega, sem desconto automático.

ALTER TABLE campanhas_fidelidade
  ADD COLUMN IF NOT EXISTS premio_servico_id integer NULL REFERENCES servicos(id) ON DELETE SET NULL;
ALTER TABLE campanhas_fidelidade
  ADD COLUMN IF NOT EXISTS premio_produto_id integer NULL REFERENCES produtos(id) ON DELETE SET NULL;
ALTER TABLE campanhas_fidelidade
  ADD COLUMN IF NOT EXISTS premio_valor numeric(10,2) NULL;

-- Uma cortesia por cliente por ação (UNIQUE usuario_id + campanha_id).
CREATE TABLE IF NOT EXISTS fidelidade_resgates (
  id serial PRIMARY KEY,
  empresa_id integer NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  campanha_id integer NOT NULL REFERENCES campanhas_fidelidade(id) ON DELETE CASCADE,
  usuario_id integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  agendamento_id integer NULL REFERENCES agendamentos(id) ON DELETE SET NULL,
  tipo_premio text NULL,
  valor_desconto numeric(10,2) NOT NULL DEFAULT 0,
  resgatado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario_id, campanha_id)
);
CREATE INDEX IF NOT EXISTS idx_fidelidade_resgates_empresa ON fidelidade_resgates(empresa_id, resgatado_em);

-- Só o backend (service_role) lê/escreve; RLS ligado sem policy nenhuma bloqueia a anon key.
ALTER TABLE fidelidade_resgates ENABLE ROW LEVEL SECURITY;
