-- Corrige inconsistência pré-existente: routes/auth.js já bloqueia login de empresa com
-- status_assinatura = 'suspensa' (usado pelo botão "Suspender" do admin absoluto, ver
-- routes/superAdminPlataforma.js), mas a CHECK constraint da coluna nunca incluiu esse valor —
-- o UPDATE pro botão de suspender sempre falhava com "new row violates check constraint".
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna/constraint nova depois disso precisa de um arquivo novo,
-- não editar este.

ALTER TABLE empresas DROP CONSTRAINT IF EXISTS empresas_status_assinatura_check;

ALTER TABLE empresas
  ADD CONSTRAINT empresas_status_assinatura_check
  CHECK (status_assinatura = ANY (ARRAY['trial', 'ativa', 'inadimplente', 'cancelada', 'suspensa']));
