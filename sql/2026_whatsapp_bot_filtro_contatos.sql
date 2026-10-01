-- Filtro de contatos pessoais pro bot de WhatsApp (ver routes/whatsapp.js e
-- routes/whatsappInstancia.js): evita o bot responder quem está salvo na agenda do celular
-- conectado (ex: dono usando o próprio número pessoal) e permite uma lista manual de números
-- que o bot nunca deve responder, independente de estarem salvos ou não.
alter table empresas
  add column if not exists whatsapp_bot_ignorar_salvos boolean not null default false,
  add column if not exists whatsapp_bot_numeros_bloqueados text;
