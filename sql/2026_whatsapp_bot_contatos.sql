-- Seleção de contatos do bot de WhatsApp (ver services/whatsapp/contatosBot.js e o card
-- "Contatos atendidos pelo bot" em AdminWhatsapp.js). Substitui o filtro antigo
-- (whatsapp_bot_ignorar_salvos + whatsapp_bot_numeros_bloqueados, digitados à mão).
--
-- whatsapp_bot_contatos_modo:
--   'todos'            — bot responde todo mundo (padrão, como sempre foi);
--   'somente_marcados' — só quem está em whatsapp_bot_contatos;
--   'todos_exceto'     — todo mundo, menos quem está em whatsapp_bot_contatos.
--
-- jid é o identificador do contato na Evolution: "5511912345678@s.whatsapp.net" ou, quando o
-- WhatsApp esconde o número por privacidade, "123456789@lid". telefone (só dígitos, com DDI)
-- é preenchido quando se sabe o número, pra comparar também com quem chega pelo número.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto.

begin;

alter table empresas
  add column if not exists whatsapp_bot_contatos_modo text not null default 'todos'
    check (whatsapp_bot_contatos_modo in ('todos', 'somente_marcados', 'todos_exceto'));

create table if not exists whatsapp_bot_contatos (
  id bigserial primary key,
  empresa_id integer not null references empresas(id) on delete cascade,
  jid text not null,
  telefone text null,
  nome text null,
  criado_em timestamptz not null default now(),
  unique (empresa_id, jid)
);
create index if not exists whatsapp_bot_contatos_empresa_telefone on whatsapp_bot_contatos (empresa_id, telefone);

-- Mesmo padrão de sql/2026_seguranca_rls_privilegios.sql: só o backend (service_role) acessa.
alter table whatsapp_bot_contatos enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'whatsapp_bot_contatos' and policyname = 'deny_all') then
    create policy deny_all on whatsapp_bot_contatos as restrictive for all to anon, authenticated using (false) with check (false);
  end if;
end $$;
revoke all on whatsapp_bot_contatos from anon, authenticated;
revoke all on sequence whatsapp_bot_contatos_id_seq from anon, authenticated;

-- Números digitados no filtro antigo viram contatos marcados no modo "todos, exceto".
insert into whatsapp_bot_contatos (empresa_id, jid, telefone)
select e.id, n || '@s.whatsapp.net', n
from empresas e, unnest(string_to_array(e.whatsapp_bot_numeros_bloqueados, ',')) as n
where coalesce(e.whatsapp_bot_numeros_bloqueados, '') <> '' and n ~ '^[0-9]{12,13}$'
on conflict (empresa_id, jid) do nothing;

update empresas set whatsapp_bot_contatos_modo = 'todos_exceto'
where coalesce(whatsapp_bot_numeros_bloqueados, '') <> '' and whatsapp_bot_contatos_modo = 'todos';

commit;
