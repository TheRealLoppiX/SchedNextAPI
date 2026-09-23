-- Login do admin absoluto (POST /super-admin/login, tabela `super_admins`) nao tinha fluxo de
-- "esqueci minha senha" - so recuperacao, sem cadastro (ver POST /super-admin/recuperar-senha e
-- /super-admin/resetar-senha em routes/superAdmin.js). Mesma coluna usada pelos outros dois
-- fluxos de codigo de 6 digitos do projeto (sql/2026_recuperacao_senha_admin.sql).
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrao do resto do projeto (sem
-- migration runner). Qualquer coluna/constraint nova depois disso precisa de um arquivo novo,
-- nao editar este.

ALTER TABLE super_admins ADD COLUMN IF NOT EXISTS codigo_verificacao varchar(6);
