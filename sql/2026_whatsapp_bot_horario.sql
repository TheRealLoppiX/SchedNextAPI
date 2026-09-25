-- Horário de funcionamento do bot de WhatsApp (opcional, configurado pela empresa).
-- whatsapp_bot_horario_ativo = false (padrão): bot responde 24h, como sempre foi.
-- true: só responde entre inicio e fim (horário de Brasília) nos dias marcados; fora disso manda
-- uma única vez a mensagem de fora do horário e fica quieto até o horário voltar.
-- Janela pode virar a meia-noite (ex: 18:00 às 02:00).

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_horario_ativo boolean NOT NULL DEFAULT false;
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_horario_inicio text NULL; -- 'HH:MM'
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_horario_fim text NULL; -- 'HH:MM'
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_horario_dias text NULL; -- dias da semana '0,1,...,6' (0 = domingo)
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_mensagem_fora text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_bot_horario_inicio_check') THEN
    ALTER TABLE empresas ADD CONSTRAINT whatsapp_bot_horario_inicio_check
      CHECK (whatsapp_bot_horario_inicio IS NULL OR whatsapp_bot_horario_inicio ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_bot_horario_fim_check') THEN
    ALTER TABLE empresas ADD CONSTRAINT whatsapp_bot_horario_fim_check
      CHECK (whatsapp_bot_horario_fim IS NULL OR whatsapp_bot_horario_fim ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
END $$;

-- Quando o bot avisou por último que está fora do horário, por conversa: serve pra avisar uma
-- vez só por período fechado (não a cada mensagem que o cliente mandar).
CREATE TABLE IF NOT EXISTS whatsapp_avisos_fora_horario (
  empresa_id integer NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  telefone text NOT NULL,
  avisado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, telefone)
);

-- Só o backend (service_role) lê/escreve; RLS ligado sem policy nenhuma bloqueia a anon key.
ALTER TABLE whatsapp_avisos_fora_horario ENABLE ROW LEVEL SECURITY;
