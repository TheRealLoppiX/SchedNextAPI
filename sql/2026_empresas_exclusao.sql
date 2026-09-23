-- Controle completo de empresas no admin absoluto (ver routes/superAdminPlataforma.js): além de
-- suspender (já existia), agora dá pra "excluir" uma empresa cadastrada errada. Soft delete
-- deliberado (não apaga a linha nem os dados relacionados, só marca e bloqueia login) - excluida_em
-- setado esconde a empresa das listagens normais e bloqueia o login do admin dela; POST
-- /super-admin/empresas/:id/excluir também libera o e-mail dela no antifraude (ver
-- services/antifraude.js) pra permitir um novo cadastro do zero.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrao do resto do projeto (sem
-- migration runner). Qualquer coluna/constraint nova depois disso precisa de um arquivo novo,
-- nao editar este.

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS excluida_em timestamptz;
