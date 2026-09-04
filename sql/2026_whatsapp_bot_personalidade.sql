-- Personalidade/comportamento do bot de WhatsApp por empresa (ver services/whatsapp/bot.js e
-- services/whatsapp/agente.js). Duas colunas ficam disponíveis pra qualquer empresa com o bot
-- ligado (permite_whatsapp_bot); as demais (modo, personalidade, temperatura) só têm efeito
-- quando o plano também libera IA (permite_ia) — sem isso o bot sempre roda no modo 'guiado'
-- com textos fixos, mesma regra já usada pra classificação de intenção.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna nova depois disso precisa de um arquivo novo, não editar
-- este.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_modo text NOT NULL DEFAULT 'guiado'; -- 'guiado' | 'livre'

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_nome text NULL; -- nome/persona do assistente (ex: "Bia")

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_personalidade text NULL; -- descrição livre de tom/estilo, vira parte do system prompt

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_boas_vindas text NULL; -- substitui a saudação padrão ("Olá! 👋") quando preenchida

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_bot_temperatura numeric(3,2) NOT NULL DEFAULT 0.6;

-- Postgres não tem "ADD CONSTRAINT IF NOT EXISTS" pra CHECK — DO block com checagem manual em
-- pg_constraint pra este arquivo continuar podendo ser rodado de novo sem erro.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_bot_modo_check') THEN
    ALTER TABLE empresas ADD CONSTRAINT whatsapp_bot_modo_check CHECK (whatsapp_bot_modo IN ('guiado', 'livre'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_bot_temperatura_check') THEN
    ALTER TABLE empresas ADD CONSTRAINT whatsapp_bot_temperatura_check CHECK (whatsapp_bot_temperatura >= 0 AND whatsapp_bot_temperatura <= 1);
  END IF;
END $$;
