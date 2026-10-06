-- Endurecimento de segurança do banco (2026-10-06).
--
-- Modelo: só o backend acessa o banco, sempre com a service_role (ver src/config/supabase.js),
-- que ignora RLS e não depende dos GRANTs abaixo. O frontend nunca fala com o Supabase direto.
-- Então anon/authenticated (as chaves "públicas" do Supabase, usadas pela API REST automática
-- /rest/v1) não têm motivo nenhum pra acessar nada — e passam a não acessar, em duas camadas:
--   1. RLS ligado em TODA tabela do schema public, com policy deny_all explícita;
--   2. sem GRANT nenhum pra anon/authenticated em tabela, sequence ou função — nem nas que
--      forem criadas no futuro (default privileges). Assim, uma tabela nova criada sem
--      lembrar de ligar RLS continua inacessível pela API pública.
--
-- Achado que motivou: login_magico_codigos, suporte_conversas, suporte_mensagens e
-- fidelidade_premios_notificados estavam com RLS desligado e legíveis com a chave anon
-- (inclusive códigos válidos de login automático de clientes).
--
-- Idempotente. Rodado via Management API/SQL editor do Supabase.

begin;

-- 1. RLS + deny_all em todas as tabelas do public
do $$
declare t record;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') loop
    execute format('alter table public.%I enable row level security', t.relname);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.relname and policyname = 'deny_all') then
      execute format('create policy deny_all on public.%I as restrictive for all to anon, authenticated using (false) with check (false)', t.relname);
    end if;
  end loop;
end $$;

-- 2. Nenhum privilégio pras roles públicas (TRUNCATE, por exemplo, nem passa pelo RLS)
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- 3. Objetos criados no futuro nascem sem acesso público
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated;

-- 4. search_path fixo nas funções (evita sequestro via objeto com o mesmo nome em outro schema)
alter function public.movimentar_estoque(integer, integer, integer) set search_path = public, pg_temp;
alter function public.consumir_cota_assinatura(integer, integer, date, integer) set search_path = public, pg_temp;

commit;
