-- Resumo diário dos horários de cada profissional via WhatsApp (ver src/cron/resumoProfissionais.js
-- e a aba Admin -> WhatsApp). Configurável por empresa: liga/desliga e horário de disparo (texto
-- 'HH:MM', horário de Brasília). Cada profissional recebe sua própria agenda do dia, e só se tiver
-- telefone cadastrado (novo campo em barbeiros, não existia até então).
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna nova depois disso precisa de um arquivo novo, não editar
-- este.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_resumo_profissionais_ativo boolean NOT NULL DEFAULT false;

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS whatsapp_resumo_profissionais_horario text NULL; -- 'HH:MM', ex: '08:00'

ALTER TABLE barbeiros
  ADD COLUMN IF NOT EXISTS telefone text NULL; -- mesma convenção de usuarios.telefone: sem DDI, só DDD+número

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_resumo_profissionais_horario_check') THEN
    ALTER TABLE empresas ADD CONSTRAINT whatsapp_resumo_profissionais_horario_check
      CHECK (whatsapp_resumo_profissionais_horario IS NULL OR whatsapp_resumo_profissionais_horario ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
END $$;
