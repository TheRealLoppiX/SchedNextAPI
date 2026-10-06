-- Mensagens do bot de WhatsApp editáveis por estado da conversa (menu, agendamento, cadastro...),
-- ver services/whatsapp/mensagensBot.js. Só guarda o que a empresa personalizou, no formato
-- {"chave": "texto"}; chave ausente = usa o padrão definido pelo admin absoluto (guardado em
-- plataforma_configuracoes, chave 'whatsapp_bot_mensagens', sem tabela nova) ou, se nem esse
-- existir, o texto de fábrica do código.
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

alter table empresas
  add column if not exists whatsapp_bot_mensagens jsonb not null default '{}'::jsonb;
