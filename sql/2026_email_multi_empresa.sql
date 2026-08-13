-- Permite que o mesmo e-mail seja cliente de MULTIPLAS empresas: cada empresa = uma
-- linha independente em `usuarios`, com senha e perfil proprios. Antes, `email` tinha
-- UNIQUE global, entao um e-mail so podia ser cliente de UMA empresa em todo o sistema
-- (POST /login ja foi corrigido para escopar por empresa_id -- ver routes/auth.js).
-- Rodar manualmente no SQL editor do Supabase.

-- 1) Confirme o nome real da constraint UNIQUE de `usuarios.email` antes de dropar
--    (o nome abaixo e o padrao do Postgres pra UNIQUE de coluna unica, mas rode isto
--    primeiro pra ter certeza):
--
-- SELECT tc.constraint_name, tc.constraint_type
-- FROM information_schema.table_constraints tc
-- WHERE tc.table_name = 'usuarios' AND tc.constraint_type = 'UNIQUE';

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_email_key;

-- Dedup defensivo: nao deveria existir nenhuma duplicata de (email, empresa_id) hoje,
-- dado o UNIQUE global antigo. So aqui por seguranca -- se a linha abaixo apagar algo,
-- investigue antes de seguir.
DELETE FROM usuarios a USING usuarios b
  WHERE a.id < b.id AND a.email = b.email AND a.empresa_id = b.empresa_id;

ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_email_empresa_unique UNIQUE (email, empresa_id);

-- cadastros_pendentes: hoje dedup por (tipo, email) apenas -- o mesmo e-mail comecando
-- cadastro em DUAS empresas na mesma janela de 30min sobrescrevia silenciosamente o
-- pendente da primeira empresa (ver services/cadastroPendente.js). empresa_id vira
-- coluna de primeira classe e entra na constraint.
--
-- NOT NULL DEFAULT 0: cadastro de EMPRESA (tipo='empresa', ver routes/empresasPublico.js)
-- ainda nao tem empresa_id -- a empresa esta sendo criada agora. Usamos 0 como sentinela
-- em vez de NULL porque UNIQUE do Postgres trata NULL <> NULL (duas linhas NULL nunca
-- colidem), o que quebraria silenciosamente o dedup do fluxo tipo='empresa'.
ALTER TABLE cadastros_pendentes
  ADD COLUMN IF NOT EXISTS empresa_id integer NOT NULL DEFAULT 0;

-- Confirme o nome real da constraint/indice unico existente antes de dropar:
--
-- SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'cadastros_pendentes';

ALTER TABLE cadastros_pendentes DROP CONSTRAINT IF EXISTS cadastros_pendentes_tipo_email_key;

ALTER TABLE cadastros_pendentes
  ADD CONSTRAINT cadastros_pendentes_tipo_email_empresa_unique UNIQUE (tipo, email, empresa_id);
