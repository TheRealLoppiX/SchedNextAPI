-- Login da barbearia (POST /auth/admin/login, tabelas `empresas` e `unidade_admins`) não tinha
-- fluxo de "esqueci minha senha" — só o login de cliente final (tabela `usuarios`) tinha. Reusa o
-- mesmo mecanismo de código de 6 dígitos (ver POST /auth/admin/recuperar-senha e
-- /auth/admin/resetar-senha em routes/auth.js).
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna/constraint nova depois disso precisa de um arquivo novo,
-- não editar este.

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS codigo_verificacao varchar(6);
ALTER TABLE unidade_admins ADD COLUMN IF NOT EXISTS codigo_verificacao varchar(6);
