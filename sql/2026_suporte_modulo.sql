-- Módulo de suporte (Admin -> Suporte / Admin absoluto -> Suporte). Chat com IA pra empresas com
-- IA liberada no plano (permite_ia, reaproveitado do mesmo flag já usado pro bot de WhatsApp —
-- decisão de produto: Grátis/Essencial ficam só com contato por e-mail, sem tabela nenhuma pra
-- isso; Profissional/Enterprise ganham o chat completo). Quando o admin da empresa toca em
-- "Falar com o time", a conversa fica visível pro admin absoluto responder.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner). Qualquer coluna/tabela nova depois disso precisa de um arquivo novo, não
-- editar este.

CREATE TABLE IF NOT EXISTS suporte_conversas (
  id bigserial PRIMARY KEY,
  empresa_id bigint NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ia', -- 'ia' | 'aguardando_humano' | 'resolvido'
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suporte_mensagens (
  id bigserial PRIMARY KEY,
  conversa_id bigint NOT NULL REFERENCES suporte_conversas(id) ON DELETE CASCADE,
  remetente text NOT NULL, -- 'empresa' | 'ia' | 'super_admin'
  super_admin_id uuid NULL REFERENCES super_admins(id) ON DELETE SET NULL, -- super_admins.id é uuid, não bigint
  texto text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suporte_mensagens_conversa ON suporte_mensagens(conversa_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_suporte_conversas_empresa ON suporte_conversas(empresa_id, atualizado_em DESC);
-- Só uma conversa não-resolvida por empresa de cada vez — mesma regra de "uma coisa ativa por
-- vez" já usada em campanhas de fidelidade (campanhas_fidelidade.ativa).
CREATE UNIQUE INDEX IF NOT EXISTS idx_suporte_conversa_ativa_unica ON suporte_conversas(empresa_id) WHERE status != 'resolvido';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suporte_conversas_status_check') THEN
    ALTER TABLE suporte_conversas ADD CONSTRAINT suporte_conversas_status_check CHECK (status IN ('ia', 'aguardando_humano', 'resolvido'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'suporte_mensagens_remetente_check') THEN
    ALTER TABLE suporte_mensagens ADD CONSTRAINT suporte_mensagens_remetente_check CHECK (remetente IN ('empresa', 'ia', 'super_admin'));
  END IF;
END $$;
