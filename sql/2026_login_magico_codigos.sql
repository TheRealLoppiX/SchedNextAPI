-- Login mágico do bot de WhatsApp (ver services/loginMagico.js e POST /login-magico em
-- routes/auth.js) — substituiu o JWT assinado (150+ caracteres, ruim de mandar por WhatsApp) por
-- um código curto de uso único guardado aqui. Cada linha é apagada assim que consumida (ou
-- simplesmente expira sozinha, sem limpeza automática — volume baixo o suficiente pra não valer
-- a pena um cron só pra isso por enquanto).
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna/tabela nova depois disso precisa de um arquivo novo, não
-- editar este.

CREATE TABLE IF NOT EXISTS login_magico_codigos (
  codigo text PRIMARY KEY,
  usuario_id bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_magico_codigos_expira ON login_magico_codigos(expira_em);
