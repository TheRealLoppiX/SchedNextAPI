-- Corrige condição de corrida no débito de cota da assinatura (assinatura_uso_mensal).
-- Rodar manualmente no SQL editor do Supabase.
--
-- calcularValorComLimiteAssinante fazia leitura (SELECT usados) e escrita (UPDATE/INSERT)
-- em passos separados, sem travar a linha. Dois fechamentos de caixa do mesmo
-- cliente/serviço/ciclo em sequência rápida podiam ler o mesmo "usados" antes de qualquer um
-- escrever, e os dois decidiam "dentro do limite" ao mesmo tempo — um cliente com limite de 1
-- corte conseguiu 2 cortes de graça. Essa função faz a checagem e o débito atomicamente numa
-- única transação, com FOR UPDATE travando a linha entre o SELECT e o UPDATE.
CREATE OR REPLACE FUNCTION consumir_cota_assinatura(
  p_usuario_id integer,
  p_servico_id integer,
  p_ciclo_ref date,
  p_limite integer
) RETURNS boolean AS $$
DECLARE
  v_usados integer;
BEGIN
  INSERT INTO assinatura_uso_mensal (usuario_id, servico_id, ciclo_ref, usados)
  VALUES (p_usuario_id, p_servico_id, p_ciclo_ref, 0)
  ON CONFLICT (usuario_id, servico_id, ciclo_ref) DO NOTHING;

  SELECT usados INTO v_usados
  FROM assinatura_uso_mensal
  WHERE usuario_id = p_usuario_id AND servico_id = p_servico_id AND ciclo_ref = p_ciclo_ref
  FOR UPDATE;

  IF v_usados < p_limite THEN
    UPDATE assinatura_uso_mensal
    SET usados = usados + 1, atualizado_em = now()
    WHERE usuario_id = p_usuario_id AND servico_id = p_servico_id AND ciclo_ref = p_ciclo_ref;
    RETURN true;
  END IF;

  RETURN false;
END;
$$ LANGUAGE plpgsql;
