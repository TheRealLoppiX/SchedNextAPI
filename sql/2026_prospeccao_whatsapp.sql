-- Prospecção de clientes por WhatsApp (admin absoluto, ver src/services/prospeccao.js e
-- routes/superAdminProspeccao.js). Lista de prospects importada de planilha + histórico de cada
-- mensagem disparada. A configuração do fluxo (limite diário, janelas, mensagens) e o nome da
-- instância de WhatsApp de prospecção ficam em plataforma_configuracoes ('prospeccao_config',
-- 'whatsapp_instancia_prospeccao'), sem tabela própria.
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

CREATE TABLE IF NOT EXISTS prospects (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  -- Só dígitos, com DDI 55 e o 9 do celular (ver normalizarCelular em services/prospeccao.js).
  telefone text NOT NULL UNIQUE,
  categoria text NULL,
  cidade text NULL,
  bairro text NULL,
  instagram text NULL,
  prioridade text NULL,
  -- 1 = Alta, 2 = Média, 3 = Baixa: a fila sai nessa ordem.
  prioridade_ordem smallint NOT NULL DEFAULT 2,
  ponto_abordagem text NULL,
  variante text NULL,
  -- Mensagens personalizadas que vieram da planilha (opcionais): quando existem e a config manda
  -- usar, substituem os modelos de abertura/follow-up.
  mensagem_abertura text NULL,
  mensagem_followup text NULL,
  origem text NULL,
  status text NOT NULL DEFAULT 'na_fila' CHECK (status IN (
    'na_fila', 'abertura_enviada', 'followup_enviado', 'respondeu', 'sem_resposta', 'optout', 'pausado', 'erro'
  )),
  mensagens_enviadas integer NOT NULL DEFAULT 0,
  ultimo_envio_em timestamptz NULL,
  respondeu_em timestamptz NULL,
  ultima_resposta text NULL,
  erro text NULL,
  observacoes text NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prospects_fila_idx ON prospects (status, prioridade_ordem, id);
CREATE INDEX IF NOT EXISTS prospects_ultimo_envio_idx ON prospects (status, ultimo_envio_em);

CREATE TABLE IF NOT EXISTS prospeccao_envios (
  id bigserial PRIMARY KEY,
  prospect_id bigint NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  -- 1 = abertura, 2 = follow-up, 0 = resposta automática ao pedido de saída.
  etapa smallint NOT NULL,
  texto text NOT NULL,
  ok boolean NOT NULL DEFAULT true,
  erro text NULL,
  enviado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prospeccao_envios_data_idx ON prospeccao_envios (enviado_em);
CREATE INDEX IF NOT EXISTS prospeccao_envios_prospect_idx ON prospeccao_envios (prospect_id);

ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospeccao_envios ENABLE ROW LEVEL SECURITY;
