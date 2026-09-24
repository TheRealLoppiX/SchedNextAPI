-- Aviso de suporte no admin absoluto (balão com contador no menu "Suporte" + aviso na tela).
-- Conta como pendência pra um super admin:
--   1. conversa escalada (status 'aguardando_humano') sem ninguém atendendo, e
--   2. conversa repassada PRA ELE que ele ainda não aceitou nem respondeu.
-- O item 2 precisa deste flag: é ligado no POST /super-admin/suporte/:id/repassar (quando o
-- destino é outra pessoa) e desligado quando o destino aceita ou manda mensagem (ver
-- routes/superAdminSuporte.js).
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

ALTER TABLE suporte_conversas ADD COLUMN IF NOT EXISTS repasse_pendente boolean NOT NULL DEFAULT false;
