-- Campanhas promocionais de preco escalonado por ciclo (ex: Black Friday - 1o mes R$9,99, 2o
-- R$19,99, demais no preco cheio) pro plano da PLATAFORMA (empresa pagando a SchedNext, nao
-- confundir com planos_assinatura, que a empresa vende pro cliente final dela). Ver
-- routes/superAdminPrecificacao.js, services/precificacaoPlataforma.js.
--
-- Uma campanha e sempre ligada a UM plano (nao a varios); tem uma janela de tempo (inicio/fim)
-- que so vale pra decidir quem ENTRA na promocao em cadastros/upgrades novos. Depois que uma
-- empresa entra, o preco escalonado dela continua valendo pelos ciclos definidos mesmo que a
-- janela ja tenha fechado - so o toggle `ativa` funciona como kill-switch geral (desligar aborta
-- os proximos passos de preco de todo mundo, mesmo quem ja tinha entrado).
CREATE TABLE campanhas_precificacao (
  id bigserial PRIMARY KEY,
  plano_plataforma_id bigint NOT NULL REFERENCES planos_plataforma(id),
  nome text NOT NULL,
  ativa boolean NOT NULL DEFAULT true,
  inicio timestamptz NOT NULL,
  fim timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE campanhas_precificacao ENABLE ROW LEVEL SECURITY;

-- Preco de cada ciclo (1o, 2o, 3o...) da campanha. Ciclo alem do maior definido aqui cai
-- automaticamente no preco cheio do plano (ver precoDoCiclo em
-- services/precificacaoPlataforma.js) - nao precisa listar "os demais" explicitamente.
CREATE TABLE campanha_precos_ciclo (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas_precificacao(id) ON DELETE CASCADE,
  numero_ciclo int NOT NULL CHECK (numero_ciclo > 0),
  valor numeric(10,2) NOT NULL CHECK (valor >= 0),
  UNIQUE (campanha_id, numero_ciclo)
);
ALTER TABLE campanha_precos_ciclo ENABLE ROW LEVEL SECURITY;

-- Livro-razao de cada ciclo de cobranca da assinatura da PLATAFORMA, cartao ou Pix. Existe por
-- dois motivos: (1) idempotencia - UNIQUE(empresa_id, ciclo_ref) garante que o mesmo ciclo nunca
-- avanca ciclo_cobranca_atual/registra receita duas vezes, mesmo com webhook duplicado do
-- Mercado Pago; (2) e o proprio mecanismo de geracao de cobranca Pix (que nao tem recorrencia
-- nativa no Mercado Pago - cada ciclo precisa de uma cobranca avulsa nova, ver
-- cron/cobrancaPlataforma.js), mesmo padrao ja usado em assinatura_cobrancas (cliente final).
CREATE TABLE plataforma_cobrancas (
  id bigserial PRIMARY KEY,
  empresa_id bigint NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ciclo_ref int NOT NULL,
  valor numeric(10,2) NOT NULL,
  forma_pagamento text NOT NULL CHECK (forma_pagamento IN ('cartao', 'pix')),
  mercadopago_payment_id text,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'pago', 'inadimplente')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  pago_em timestamptz,
  UNIQUE (empresa_id, ciclo_ref)
);
ALTER TABLE plataforma_cobrancas ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_plataforma_cobrancas_mp_payment_id ON plataforma_cobrancas(mercadopago_payment_id);

-- campanha_precificacao_id: qual campanha essa empresa entrou (null = preco cheio normal, sem
-- promocao). ciclo_cobranca_atual: qual ciclo ela esta cursando agora (1 = ainda no primeiro
-- pagamento), usado pra saber qual preco cobrar/ajustar no proximo ciclo. plataforma_forma_pagamento:
-- cartao (preapproval, existia) ou pix (novo, ver cron/cobrancaPlataforma.js) - null = nunca
-- configurou cobranca nenhuma (ex: plano Gratis).
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS campanha_precificacao_id bigint REFERENCES campanhas_precificacao(id) ON DELETE SET NULL;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ciclo_cobranca_atual int NOT NULL DEFAULT 1;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plataforma_forma_pagamento text CHECK (plataforma_forma_pagamento IN ('cartao', 'pix'));
