-- Admin absoluto: (1) liga/desliga plano, (2) dias de teste por plano, (3) antifraude de
-- cadastro (uma pessoa/empresa = um teste gratis), (4) aviso de fim de teste, (5) area de teste
-- de planos (plano oculto/desligado aplicado temporariamente a UMA empresa escolhida).
-- Rodar no SQL editor do Supabase (sem migration runner). Nao editar depois de aplicado:
-- mudancas de schema vao em arquivo novo.

-- (1) ativo: false = plano some da landing/cadastro e nao pode ser contratado por ninguem
-- (empresas que ja estao nele continuam). (5) publico: false = plano existe mas nao e listado
-- nem contratavel pelo site; so o admin absoluto aplica (area de teste).
-- (2) dias_teste: NULL = sem limite de tempo; N = conta nova nesse plano tem N dias de teste.
ALTER TABLE planos_plataforma
  ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS publico boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dias_teste integer NULL CHECK (dias_teste IS NULL OR dias_teste > 0);

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS telefone text NULL,
  ADD COLUMN IF NOT EXISTS trial_expira_em timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_aviso_enviado_em timestamptz NULL,
  ADD COLUMN IF NOT EXISTS trial_expirado_avisado_em timestamptz NULL,
  -- Area de teste de planos: plano que a empresa tinha antes, pra voltar quando o teste acabar.
  ADD COLUMN IF NOT EXISTS plano_teste_expira_em timestamptz NULL,
  ADD COLUMN IF NOT EXISTS plano_teste_anterior_id integer NULL REFERENCES planos_plataforma(id);

-- (3) Livro-razao de cadastros: uma linha por empresa criada, com os identificadores JA
-- normalizados. Sobrevive a exclusao da empresa (empresa_id vira NULL), senao apagar a conta e
-- recriar burlaria a checagem.
CREATE TABLE IF NOT EXISTS cadastro_empresa_registros (
  id serial PRIMARY KEY,
  empresa_id integer NULL REFERENCES empresas(id) ON DELETE SET NULL,
  nome_empresa text NULL,
  email_normalizado text NOT NULL,
  telefone_normalizado text NULL,
  documento text NULL,          -- CPF ou CNPJ, so digitos
  nome_normalizado text NULL,
  ip text NULL,
  liberado_em timestamptz NULL, -- admin absoluto liberou (falso positivo): deixa de bloquear
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cadreg_email ON cadastro_empresa_registros (email_normalizado);
CREATE INDEX IF NOT EXISTS idx_cadreg_telefone ON cadastro_empresa_registros (telefone_normalizado);
CREATE INDEX IF NOT EXISTS idx_cadreg_documento ON cadastro_empresa_registros (documento);
CREATE INDEX IF NOT EXISTS idx_cadreg_nome ON cadastro_empresa_registros (nome_normalizado);

ALTER TABLE cadastro_empresa_registros ENABLE ROW LEVEL SECURITY;
