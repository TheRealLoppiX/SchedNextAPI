const supabase = require('../config/supabase');

const VALIDADE_MINUTOS = 30;

// Guarda um cadastro (cliente ou empresa) em espera de confirmação por e-mail. Nada é
// gravado na tabela de verdade (usuarios/empresas) até o código ser confirmado — assim
// uma conta nunca existe (e muito menos consegue logar) antes de confirmada. Upsert por
// (tipo, email, empresa_id): tentar de novo antes de confirmar só substitui pelo código
// mais recente. empresa_id entra na chave pra um cliente conseguir ter cadastros pendentes
// em duas empresas diferentes ao mesmo tempo sem um sobrescrever o outro (ver
// sql/2026_email_multi_empresa.sql). Cadastro de empresa (tipo='empresa') ainda não tem
// empresa_id — usa o sentinela 0 (NULL quebraria o dedup, já que UNIQUE trata NULL <> NULL).
async function criarPendente({ tipo, email, empresa_id, codigo, dados }) {
  const expiraEm = new Date(Date.now() + VALIDADE_MINUTOS * 60000).toISOString();
  return supabase
    .from('cadastros_pendentes')
    .upsert(
      { tipo, email, empresa_id: empresa_id ?? 0, codigo_verificacao: codigo, dados, expira_em: expiraEm },
      { onConflict: 'tipo,email,empresa_id' }
    );
}

async function buscarPendenteValido({ tipo, email, codigo }) {
  const { data, error } = await supabase
    .from('cadastros_pendentes')
    .select('id, dados, expira_em')
    .eq('tipo', tipo)
    .eq('email', email)
    .eq('codigo_verificacao', codigo)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expira_em) < new Date()) return null;
  return data;
}

async function removerPendente(id) {
  return supabase.from('cadastros_pendentes').delete().eq('id', id);
}

module.exports = { criarPendente, buscarPendenteValido, removerPendente };
