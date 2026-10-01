-- Assinatura de cliente final: dias da semana em que cada plano vale e vencimento configurável
-- pela empresa (ver utils/limitesAssinatura.js, services/vencimentoAssinatura.js,
-- routes/assinaturas.js e cron/cobrancaAssinaturas.js).
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

-- 1) Dias da semana do plano (0 = domingo ... 6 = sábado). NULL = todos os dias, como sempre foi.
-- Fora desses dias o assinante agenda normalmente, pagando como cliente comum.
ALTER TABLE planos_assinatura ADD COLUMN IF NOT EXISTS dias_semana smallint[];

-- 2) Vencimento das mensalidades, por empresa.
--    modo 'data_assinatura': como sempre, vence no dia em que o cliente assinou.
--    modo 'dias_fixos': vence num dos dias escolhidos pela empresa (1 a 28), que o cliente escolhe.
--    primeira_cobranca (só no Pix; no cartão a 1ª cobrança é sempre no dia fixo):
--      'proporcional'      paga ao assinar só os dias até o vencimento, depois o valor cheio;
--      'cheia_ciclo_longo' paga cheio ao assinar e o 1º ciclo vai até o dia fixo depois de 1 mês;
--      'no_dia_fixo'       não paga ao assinar, o plano já vale e a 1ª cobrança é no dia fixo.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS assinatura_modo_vencimento text NOT NULL DEFAULT 'data_assinatura';
ALTER TABLE empresas DROP CONSTRAINT IF EXISTS empresas_assinatura_modo_vencimento_check;
ALTER TABLE empresas ADD CONSTRAINT empresas_assinatura_modo_vencimento_check
  CHECK (assinatura_modo_vencimento IN ('data_assinatura', 'dias_fixos'));
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS assinatura_dias_vencimento smallint[];
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS assinatura_primeira_cobranca text NOT NULL DEFAULT 'proporcional';
ALTER TABLE empresas DROP CONSTRAINT IF EXISTS empresas_assinatura_primeira_cobranca_check;
ALTER TABLE empresas ADD CONSTRAINT empresas_assinatura_primeira_cobranca_check
  CHECK (assinatura_primeira_cobranca IN ('proporcional', 'cheia_ciclo_longo', 'no_dia_fixo'));

-- 3) Cobranças: 'ajuste_vencimento' marca a cobrança proporcional de ajuste até o dia fixo (não
-- conta como ciclo, então não consome o preço promocional do 1º mês de uma campanha).
ALTER TABLE assinatura_cobrancas ADD COLUMN IF NOT EXISTS ajuste_vencimento boolean NOT NULL DEFAULT false;

-- 4) Migração de quem já assina pros dias fixos: fica agendada pra próxima cobrança do cliente
-- (vencimento_migrar_em). Nesse dia o cron troca assinante_desde pela nova âncora e gera a
-- cobrança de transição conforme a regra da empresa. Trocar na hora zeraria a cota do ciclo em
-- andamento.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS vencimento_migrar_em date;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS vencimento_nova_ancora date;

NOTIFY pgrst, 'reload schema';
