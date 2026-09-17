-- Livro-caixa da PLATAFORMA (SchedNext), separado do financeiro de cada barbearia
-- (agendamentos/assinatura_cobrancas, ver routes/relatorios.js). Duas fontes de receita real:
--
--   'assinatura_plataforma' -> empresa pagando o próprio plano da SchedNext (preço do plano,
--   ver planos_plataforma.preco_mensal), cobrado via preapproval no access_token da PLATAFORMA
--   (services/pagamento.js).
--
--   'taxa_marketplace' -> nossa fatia (application_fee) de cada Pix/cartão que uma barbearia
--   cobra do cliente dela (atendimento avulso ou mensalidade), ver utils/limitesPlano.js
--   (obterTaxaMarketplace) e services/mercadopago.js. Até esta migration, esse dinheiro nunca
--   era registrado em lugar nenhum como valor recebido, só configurado como parâmetro de
--   cobrança.
--
-- Cada linha é UMA cobrança confirmada de verdade (nunca estimada) — sem isso não dá pra
-- calcular faturamento/receita líquida reais, só projeção (ver GET /super-admin/metricas).
-- Alimentado por services/receitaPlataforma.js a partir de agora; não há como reconstruir
-- receita de antes desta migration rodar.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner).

CREATE TABLE IF NOT EXISTS plataforma_receitas (
  id bigserial PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('assinatura_plataforma', 'taxa_marketplace')),
  empresa_id integer NOT NULL REFERENCES empresas(id),
  valor_bruto numeric(10,2) NOT NULL CHECK (valor_bruto >= 0),
  valor_liquido numeric(10,2) NOT NULL CHECK (valor_liquido >= 0),
  forma_pagamento text NULL CHECK (forma_pagamento IN ('pix', 'cartao')),
  -- id do pagamento no Mercado Pago que gerou essa receita. Chave de idempotência: o mesmo
  -- pagamento pode ser reconfirmado mais de uma vez (retry de webhook, polling do cliente E
  -- webhook chegando quase juntos) — sem isso a mesma cobrança contaria como receita várias
  -- vezes. NULL só é aceitável se um dia existir uma fonte de receita sem pagamento associado.
  referencia_externa text NULL,
  descricao text NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS plataforma_receitas_referencia_unica
  ON plataforma_receitas (tipo, referencia_externa)
  WHERE referencia_externa IS NOT NULL;

CREATE INDEX IF NOT EXISTS plataforma_receitas_criado_em_idx ON plataforma_receitas (criado_em);
CREATE INDEX IF NOT EXISTS plataforma_receitas_empresa_id_idx ON plataforma_receitas (empresa_id);

-- Só o backend (service_role, que ignora RLS) acessa esta tabela — mesmo padrão de isolamento
-- das demais tabelas novas do projeto (RLS ligada, sem nenhuma policy = deny total pra
-- anon/authenticated).
ALTER TABLE plataforma_receitas ENABLE ROW LEVEL SECURITY;
