-- Campanhas promocionais de preco escalonado por ciclo (ex: 1o mes R$19,90, 2o R$29,90, demais
-- no preco cheio) pra assinatura de CLIENTE FINAL (mensalidade que ele paga pra propria
-- barbearia) - mesmo conceito de sql/2026_campanhas_precificacao.sql, so que escopado por
-- empresa_id (cada barbearia cria as proprias campanhas pros proprios planos_assinatura, nao um
-- painel unico da SchedNext). Ver routes/campanhasAssinatura.js, services/precificacaoAssinatura.js.
--
-- Feature de plano (diferencial pra empresa fazer upgrade): so empresas cujo plano_plataforma
-- tem permite_campanhas_assinatura=true conseguem CRIAR campanha (ver
-- utils/limitesPlano.js:permiteCampanhasAssinatura).
ALTER TABLE planos_plataforma ADD COLUMN IF NOT EXISTS permite_campanhas_assinatura boolean NOT NULL DEFAULT false;

CREATE TABLE campanhas_assinatura (
  id bigserial PRIMARY KEY,
  empresa_id bigint NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  plano_assinatura_id bigint NOT NULL REFERENCES planos_assinatura(id) ON DELETE CASCADE,
  nome text NOT NULL,
  ativa boolean NOT NULL DEFAULT true,
  inicio timestamptz NOT NULL,
  fim timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE campanhas_assinatura ENABLE ROW LEVEL SECURITY;

CREATE TABLE campanha_assinatura_precos_ciclo (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas_assinatura(id) ON DELETE CASCADE,
  numero_ciclo int NOT NULL CHECK (numero_ciclo > 0),
  valor numeric(10,2) NOT NULL CHECK (valor >= 0),
  UNIQUE (campanha_id, numero_ciclo)
);
ALTER TABLE campanha_assinatura_precos_ciclo ENABLE ROW LEVEL SECURITY;

-- campanha_assinatura_id: qual campanha esse cliente entrou (null = preco cheio normal).
-- ciclo_cobranca_atual: qual ciclo ele esta cursando agora (1 = ainda no primeiro pagamento) -
-- o registro existente de assinatura_cobrancas usa ciclo_ref como DATA (ancora de cobranca), nao
-- como numero ordinal, entao precisa desta coluna nova pra saber "isso e o 1o, 2o, 3o... ciclo".
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS campanha_assinatura_id bigint REFERENCES campanhas_assinatura(id) ON DELETE SET NULL;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ciclo_cobranca_atual int NOT NULL DEFAULT 1;
