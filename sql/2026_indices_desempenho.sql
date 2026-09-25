-- Índices de desempenho nas tabelas mais consultadas (agenda, clientes, equipe, serviços).
-- Não muda nenhum dado nem comportamento: só deixa as buscas mais rápidas conforme a base cresce.
-- Seguro rodar mais de uma vez: cada índice só é criado se ainda não existir um índice com as
-- mesmas colunas (o banco veio de uma migração do MySQL, então alguns podem já existir).

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- agenda do dia da empresa (dashboard, stats, relatórios, disponibilidade)
    ('agendamentos',         'idx_agendamentos_empresa_data',     'empresa_id, data_hora'),
    -- horários ocupados do profissional no dia (tela de agendamento do cliente)
    ('agendamentos',         'idx_agendamentos_barbeiro_data',    'barbeiro_id, data_hora'),
    -- "já tem agendamento neste dia" e "meus horários" do cliente
    ('agendamentos',         'idx_agendamentos_usuario_data',     'usuario_id, data_hora'),
    -- serviços de cada agendamento (joins em quase toda listagem)
    ('agendamento_servicos', 'idx_agendamento_servicos_agend',    'agendamento_id'),
    -- clientes da empresa por tipo (lista de clientes, novos clientes)
    ('usuarios',             'idx_usuarios_empresa_tipo',         'empresa_id, tipo'),
    ('barbeiros',            'idx_barbeiros_empresa',             'empresa_id'),
    ('servicos',             'idx_servicos_empresa',              'empresa_id'),
    ('barbeiro_servicos',    'idx_barbeiro_servicos_barbeiro',    'barbeiro_id'),
    ('bloqueios',            'idx_bloqueios_barbeiro',            'barbeiro_id'),
    ('avaliacoes',           'idx_avaliacoes_barbeiro',           'barbeiro_id'),
    ('notificacoes',         'idx_notificacoes_usuario',          'usuario_id')
  ) AS v(tabela, nome, colunas)
  LOOP
    IF to_regclass('public.' || r.tabela) IS NULL THEN
      RAISE NOTICE 'Tabela % não existe, pulando', r.tabela;
    ELSIF EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = r.tabela
        AND replace(indexdef, ' ', '') ILIKE '%(' || replace(r.colunas, ' ', '') || ')%'
    ) THEN
      RAISE NOTICE 'Já existe índice em %(%), pulando', r.tabela, r.colunas;
    ELSE
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%s)', r.nome, r.tabela, r.colunas);
      RAISE NOTICE 'Criado % em %(%)', r.nome, r.tabela, r.colunas;
    END IF;
  END LOOP;
END $$;

-- Conferência: lista os índices dessas tabelas depois de rodar.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('agendamentos', 'agendamento_servicos', 'usuarios', 'barbeiros', 'servicos',
                    'barbeiro_servicos', 'bloqueios', 'avaliacoes', 'notificacoes')
ORDER BY tablename, indexname;
