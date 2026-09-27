-- Preco cheio "travado" no momento em que a empresa passou a pagar o plano da PLATAFORMA. Sem
-- isso, o Pix (cobranca avulsa gerada todo mes, ver cron/cobrancaPlataforma.js) e o fim de uma
-- campanha no cartao usavam o preco_mensal ATUAL do plano: um aumento de preco no admin absoluto
-- atingia quem ja assinava no Pix, mas nao quem assinava no cartao sem campanha (o preapproval
-- guarda o valor antigo). Agora aumento de preco so vale pra quem assina dali em diante.
-- Ver services/precificacaoPlataforma.js (precoCheioDaEmpresa/registrarPrecoContratado).
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plataforma_preco_contratado numeric(10,2);

-- Quem ja paga hoje fica travado no preco atual do plano (mesmo valor que ja estava sendo usado).
UPDATE empresas e
SET plataforma_preco_contratado = p.preco_mensal
FROM planos_plataforma p
WHERE p.id = e.plano_plataforma_id
  AND p.preco_mensal > 0
  AND e.plataforma_forma_pagamento IS NOT NULL
  AND e.plataforma_preco_contratado IS NULL;
