const supabase = require('../config/supabase');
const { normalizarEmail, normalizarNomeEmpresa, normalizarTelefone, normalizarDocumento } = require('../utils/antifraude');

// Antifraude de cadastro de empresa: impede que a mesma pessoa/negócio crie várias contas
// (principalmente pra reciclar o teste grátis). Compara e-mail (normalizado: pontos e +tag do
// Gmail), telefone (DDD + 8 últimos dígitos), CPF/CNPJ e nome da empresa contra o livro-razão
// cadastro_empresa_registros (ver sql/2026_planos_ativo_trial_antifraude.sql), que sobrevive
// à exclusão da empresa. E-mail, telefone e documento iguais BLOQUEIAM; nome igual só sinaliza
// (nomes comuns colidem legitimamente) e aparece no painel do admin absoluto.
function identificadores({ email, telefone, documento, nome }) {
  return {
    email_normalizado: normalizarEmail(email),
    telefone_normalizado: normalizarTelefone(telefone),
    documento: normalizarDocumento(documento),
    nome_normalizado: normalizarNomeEmpresa(nome) || null
  };
}

async function buscarDuplicidades(ids) {
  const filtros = [`email_normalizado.eq.${ids.email_normalizado}`];
  if (ids.telefone_normalizado) filtros.push(`telefone_normalizado.eq.${ids.telefone_normalizado}`);
  if (ids.documento) filtros.push(`documento.eq.${ids.documento}`);
  if (ids.nome_normalizado) filtros.push(`nome_normalizado.eq.${ids.nome_normalizado}`);

  const { data, error } = await supabase
    .from('cadastro_empresa_registros')
    .select('id, empresa_id, nome_empresa, email_normalizado, telefone_normalizado, documento, nome_normalizado, criado_em')
    .is('liberado_em', null)
    .or(filtros.join(','));

  if (error) throw error;

  return (data || []).map((r) => ({
    ...r,
    campos: [
      r.email_normalizado === ids.email_normalizado && 'email',
      ids.telefone_normalizado && r.telefone_normalizado === ids.telefone_normalizado && 'telefone',
      ids.documento && r.documento === ids.documento && 'documento',
      ids.nome_normalizado && r.nome_normalizado === ids.nome_normalizado && 'nome'
    ].filter(Boolean)
  }));
}

const ROTULOS = { email: 'e-mail', telefone: 'telefone', documento: 'CPF/CNPJ' };

// null = liberado; string = mensagem de bloqueio pro usuário.
async function verificarCadastro(dados) {
  const ids = identificadores(dados);
  const achados = await buscarDuplicidades(ids);
  const camposBloqueantes = [...new Set(achados.flatMap((a) => a.campos).filter((c) => c !== 'nome'))];
  if (!camposBloqueantes.length) return null;

  return `Já existe uma conta na SchedNext com o mesmo ${camposBloqueantes.map((c) => ROTULOS[c]).join(', ')}. Entre na conta existente ou fale com o suporte.`;
}

async function registrarCadastro({ empresaId, nomeEmpresa, ip, ...dados }) {
  const ids = identificadores({ ...dados, nome: nomeEmpresa });
  const { error } = await supabase.from('cadastro_empresa_registros').insert({
    empresa_id: empresaId,
    nome_empresa: nomeEmpresa,
    ...ids,
    ip: ip || null
  });
  if (error) console.error('Erro ao registrar cadastro no antifraude:', error);
}

module.exports = { verificarCadastro, registrarCadastro, buscarDuplicidades, identificadores };
