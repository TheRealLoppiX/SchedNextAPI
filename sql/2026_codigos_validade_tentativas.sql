-- Validade e limite de tentativas dos códigos de 6 dígitos mandados por e-mail (ver
-- src/services/codigoSeguranca.js). Antes o código ficava gravado sem data nenhuma e podia ser
-- tentado sem limite por conta. Códigos já existentes (sem codigo_expira_em) passam a ser
-- tratados como vencidos: quem estava no meio de uma recuperação de senha pede um novo.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto.

begin;

alter table usuarios
  add column if not exists codigo_expira_em timestamptz null,
  add column if not exists codigo_tentativas integer not null default 0;

alter table empresas
  add column if not exists codigo_expira_em timestamptz null,
  add column if not exists codigo_tentativas integer not null default 0;

alter table unidade_admins
  add column if not exists codigo_expira_em timestamptz null,
  add column if not exists codigo_tentativas integer not null default 0;

alter table super_admins
  add column if not exists codigo_expira_em timestamptz null,
  add column if not exists codigo_tentativas integer not null default 0;

alter table cadastros_pendentes
  add column if not exists tentativas integer not null default 0;

-- Códigos antigos, sem validade: invalidados de uma vez.
update usuarios set codigo_verificacao = null where codigo_verificacao is not null;
update empresas set codigo_verificacao = null where codigo_verificacao is not null;
update unidade_admins set codigo_verificacao = null where codigo_verificacao is not null;
update super_admins set codigo_verificacao = null where codigo_verificacao is not null;

commit;
