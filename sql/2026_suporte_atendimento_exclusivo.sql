-- Reformulação do módulo de suporte (ver routes/suporte.js e superAdminSuporte.js): quando um
-- admin absoluto "aceita" um caso escalado, ele fica exclusivo pra esse admin responder até ser
-- repassado pra outro — antes disso, qualquer super admin logado podia responder qualquer
-- conversa ao mesmo tempo, sem trava nenhuma.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna/tabela nova depois disso precisa de um arquivo novo, não
-- editar este.

ALTER TABLE suporte_conversas
  ADD COLUMN IF NOT EXISTS atendido_por_super_admin_id uuid NULL REFERENCES super_admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_suporte_conversas_atendido_por ON suporte_conversas(atendido_por_super_admin_id);
