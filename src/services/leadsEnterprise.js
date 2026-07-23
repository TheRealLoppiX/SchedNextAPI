const supabase = require('../config/supabase');

// Compartilhado pelas duas rotas que recebem o formulário de contato do Enterprise (admin de
// empresa já logado e cadastro público) — ver routes/empresa.js e routes/empresasPublico.js.
async function registrarLead({ empresaId, dados }) {
  return supabase.from('leads_enterprise').insert({
    empresa_id: empresaId || null,
    nome_empresa: dados.nome_empresa,
    cnpj: dados.cnpj,
    localizacao: dados.localizacao,
    clientes_esperados: dados.clientes_esperados,
    observacoes: dados.observacoes || null,
    email_contato: dados.email_contato,
    telefone_contato: dados.telefone_contato || null
  });
}

module.exports = { registrarLead };
