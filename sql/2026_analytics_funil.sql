-- Analytics próprio do site institucional da SchedNext (landing, docs, cadastro de empresa e
-- login do admin), pra montar o funil de conversão no admin absoluto (Visão geral -> Funil de
-- conversão). Não usa Google Analytics nem cookie de terceiro: o front (utils/analytics.js)
-- gera um id de visitante (localStorage) e um id de sessão (expira após 30 min parado) e manda
-- os eventos em lote pra POST /analytics/eventos (ver routes/analytics.js).
--
-- Nada de dado pessoal aqui: não grava IP, e-mail, nome nem o que foi digitado nos campos, só
-- QUAL campo foi tocado. Localização vem dos cabeçalhos de geolocalização do Cloudflare
-- (cf-ipcountry / cf-region / cf-ipcity), já resolvida por ele.
--
-- Rodado via SQL editor do Supabase, mesmo padrão do resto do projeto (sem migration runner).

CREATE TABLE IF NOT EXISTS analytics_sessoes (
  id uuid PRIMARY KEY,                 -- gerado no navegador
  visitante_id uuid NOT NULL,          -- persiste entre sessões (localStorage)
  iniciada_em timestamptz NOT NULL DEFAULT now(),
  ultima_atividade timestamptz NOT NULL DEFAULT now(),
  -- Atribuição (de onde veio), classificada no backend a partir dos dados crus abaixo
  canal text NOT NULL DEFAULT 'direto', -- 'direto' | 'organico' | 'pago' | 'social' | 'referencia' | 'email'
  origem text,                          -- ex: google, instagram, facebook, bing, chatgpt.com...
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  tem_clid boolean NOT NULL DEFAULT false, -- veio com gclid/fbclid/msclkid (anúncio)
  referrer text,
  pagina_entrada text,
  -- Dispositivo
  dispositivo text,                     -- 'mobile' | 'tablet' | 'desktop'
  sistema text,
  navegador text,
  largura_tela int,
  idioma text,
  fuso text,
  -- Localização (Cloudflare)
  pais text,
  estado text,
  cidade text
);

CREATE TABLE IF NOT EXISTS analytics_eventos (
  id bigserial PRIMARY KEY,
  sessao_id uuid NOT NULL REFERENCES analytics_sessoes(id) ON DELETE CASCADE,
  tipo text NOT NULL,                   -- 'pagina' | 'clique' | 'evento' | 'secao'
  nome text NOT NULL,                   -- caminho da página, nome do botão ou do evento
  caminho text,                         -- página onde aconteceu
  dados jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_sessoes_iniciada ON analytics_sessoes(iniciada_em);
CREATE INDEX IF NOT EXISTS idx_analytics_eventos_sessao ON analytics_eventos(sessao_id);
CREATE INDEX IF NOT EXISTS idx_analytics_eventos_criado ON analytics_eventos(criado_em);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analytics_eventos_tipo_check') THEN
    ALTER TABLE analytics_eventos ADD CONSTRAINT analytics_eventos_tipo_check CHECK (tipo IN ('pagina', 'clique', 'evento', 'secao'));
  END IF;
END $$;

-- Só o backend (service_role) lê/escreve; RLS ligado sem policy nenhuma bloqueia a anon key.
ALTER TABLE analytics_sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_eventos ENABLE ROW LEVEL SECURITY;
