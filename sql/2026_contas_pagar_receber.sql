-- Contas a Pagar e a Receber DA PLATAFORMA (livro financeiro operacional do admin absoluto),
-- separado de plataforma_receitas (ver sql/2026_plataforma_receitas.sql) que só registra
-- cobranças JÁ confirmadas de assinatura/marketplace. Aqui é lançamento manual: despesas da
-- SchedNext (contas_pagar) e valores previstos a receber (contas_receber), incluindo os
-- vinculados a uma empresa cadastrada e sua data de próxima cobrança (empresas.proxima_cobranca_em).
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna nova depois disso precisa de um arquivo novo, não editar
-- este.

CREATE TABLE IF NOT EXISTS contas_pagar (
  id bigserial PRIMARY KEY,
  descricao text NOT NULL,
  categoria text NULL, -- 'infraestrutura' | 'marketing' | 'folha' | 'impostos' | 'fornecedor' | 'outro' (livre, sem CHECK pra não travar categoria nova)
  beneficiario_nome text NOT NULL,
  beneficiario_documento text NULL, -- CPF/CNPJ de quem recebe
  forma_pagamento text NULL, -- 'pix' | 'ted' | 'boleto' | 'dinheiro' | 'cartao' | 'outro'
  chave_pix text NULL,
  banco text NULL,
  agencia text NULL,
  conta text NULL,
  valor numeric(10,2) NOT NULL CHECK (valor >= 0),
  data_vencimento date NOT NULL,
  data_pagamento date NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'pago', 'cancelado')),
  observacoes text NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contas_pagar_status_idx ON contas_pagar (status);
CREATE INDEX IF NOT EXISTS contas_pagar_data_vencimento_idx ON contas_pagar (data_vencimento);

CREATE TABLE IF NOT EXISTS contas_receber (
  id bigserial PRIMARY KEY,
  -- Vínculo opcional com empresa cadastrada (ver empresas.proxima_cobranca_em) — usado quando o
  -- valor a receber é a mensalidade de plataforma dessa empresa. NULL pra recebimento avulso
  -- (ex: negociação Enterprise à parte, sem empresa cadastrada ainda).
  empresa_id integer NULL REFERENCES empresas(id) ON DELETE SET NULL,
  pagador_nome text NOT NULL,
  descricao text NOT NULL,
  valor numeric(10,2) NOT NULL CHECK (valor >= 0),
  data_prevista date NOT NULL,
  data_recebimento date NULL,
  forma_pagamento text NULL, -- 'pix' | 'ted' | 'boleto' | 'dinheiro' | 'cartao' | 'outro'
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'recebido', 'cancelado')),
  observacoes text NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contas_receber_status_idx ON contas_receber (status);
CREATE INDEX IF NOT EXISTS contas_receber_data_prevista_idx ON contas_receber (data_prevista);
CREATE INDEX IF NOT EXISTS contas_receber_empresa_id_idx ON contas_receber (empresa_id);

-- Só o backend (service_role, que ignora RLS) acessa essas tabelas — mesmo padrão de isolamento
-- das demais tabelas novas do projeto (RLS ligada, sem nenhuma policy = deny total pra
-- anon/authenticated).
ALTER TABLE contas_pagar ENABLE ROW LEVEL SECURITY;
ALTER TABLE contas_receber ENABLE ROW LEVEL SECURITY;
