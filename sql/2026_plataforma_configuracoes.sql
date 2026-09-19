-- Configurações gerais da PLATAFORMA (chave/valor), pra dados que não são de uma empresa nem
-- de um usuário — ex: número de WhatsApp próprio da SchedNext usado pra mandar cobrança/aviso
-- pras empresas cadastradas (diferente da instância de WhatsApp de CADA empresa, essa sim
-- guardada em empresas.whatsapp_phone_number_id, usada pra falar com OS CLIENTES dela). Serve
-- de cadastro genérico pra qualquer outro dado de contato/serviço da própria plataforma que
-- surgir depois, sem precisar de migration nova a cada campo.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner).

CREATE TABLE IF NOT EXISTS plataforma_configuracoes (
  chave text PRIMARY KEY,
  valor text NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plataforma_configuracoes ENABLE ROW LEVEL SECURITY;
