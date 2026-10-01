-- Todo plano pago é pago (salvo teste grátis do plano, chave de ativação e "Testar planos"):
-- troca de plano feita pelo admin absoluto (manual, plano exclusivo, Enterprise) vira cobrança
-- enviada pra empresa (e-mail, WhatsApp da plataforma e aviso no painel) e o plano só vale depois
-- de pago, igual à troca feita pela própria empresa. Ver services/cobrancaPlanoEmpresa.js.
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

-- 1) Série de cobrança: cada nova contratação de plano abre uma série, e os ciclos (1, 2, 3...)
-- são únicos dentro dela. Antes o UNIQUE era (empresa_id, ciclo_ref) e o ciclo volta pro 1 a
-- cada troca de plano: a 2ª troca por Pix não gravava a cobrança (pagamento nunca reconhecido),
-- e renovação/confirmação de ciclo depois de uma troca batia no ciclo do plano antigo e era
-- pulada (mês sem cobrança, receita sem registro).
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plataforma_serie int NOT NULL DEFAULT 0;
ALTER TABLE plataforma_cobrancas ADD COLUMN IF NOT EXISTS serie int NOT NULL DEFAULT 0;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'plataforma_cobrancas'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (empresa_id, ciclo_ref)'
  LOOP
    EXECUTE format('ALTER TABLE plataforma_cobrancas DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS plataforma_cobrancas_empresa_serie_ciclo_unique
  ON plataforma_cobrancas (empresa_id, serie, ciclo_ref);

-- 2) Qual plano/campanha a cobrança de contratação ativa ao ser paga, e quem originou
-- ('empresa' = trocou pela Conta; 'admin' = enviada pelo admin absoluto).
ALTER TABLE plataforma_cobrancas ADD COLUMN IF NOT EXISTS plano_plataforma_id bigint REFERENCES planos_plataforma(id);
ALTER TABLE plataforma_cobrancas ADD COLUMN IF NOT EXISTS campanha_precificacao_id bigint REFERENCES campanhas_precificacao(id) ON DELETE SET NULL;
ALTER TABLE plataforma_cobrancas ADD COLUMN IF NOT EXISTS origem text;

-- 3) 'cancelada': cobrança de contratação substituída por uma nova (ex: admin reenviou).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'plataforma_cobrancas'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE plataforma_cobrancas DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE plataforma_cobrancas ADD CONSTRAINT plataforma_cobrancas_status_check
  CHECK (status IN ('pendente', 'pago', 'inadimplente', 'cancelada'));

NOTIFY pgrst, 'reload schema';
