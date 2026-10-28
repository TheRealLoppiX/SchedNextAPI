const crypto = require('crypto');
const supabase = require('../config/supabase');

// Códigos de 6 dígitos mandados por e-mail (recuperação de senha, troca de e-mail/senha,
// confirmação de cadastro). Ver sql/2026_codigos_validade_tentativas.sql.
//
// Antes: gerados com Math.random() (previsível), sem validade nenhuma (ficavam válidos até
// serem usados) e sem limite de tentativas por conta — só o limite por IP do codigoLimiter, que
// um atacante com vários IPs contorna. Como o código tem só 10^6 combinações, isso permitia
// adivinhar o código de recuperação de qualquer conta. Agora: gerador criptográfico, validade
// curta e no máximo MAX_TENTATIVAS erros por código, depois disso ele é invalidado e é preciso
// pedir outro.

const VALIDADE_MINUTOS = 15;
const MAX_TENTATIVAS = 5;

function gerarCodigo() {
  return crypto.randomInt(100000, 1000000).toString();
}

// Campos pra gravar junto com um código novo, nas tabelas com código "na própria linha"
// (usuarios, empresas, unidade_admins, super_admins).
function camposNovoCodigo(codigo = gerarCodigo()) {
  return {
    codigo,
    campos: {
      codigo_verificacao: codigo,
      codigo_expira_em: new Date(Date.now() + VALIDADE_MINUTOS * 60000).toISOString(),
      codigo_tentativas: 0
    }
  };
}

const CAMPOS_LIMPOS = { codigo_verificacao: null, codigo_expira_em: null, codigo_tentativas: 0 };

function iguais(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function aindaValido(linha) {
  return !!linha.codigo_verificacao
    && !!linha.codigo_expira_em
    && new Date(linha.codigo_expira_em) > new Date()
    && (linha.codigo_tentativas || 0) < MAX_TENTATIVAS;
}

// Confere o código digitado contra as linhas candidatas (já buscadas pelo identificador da
// conta, ex: e-mail — nunca pelo próprio código, senão cada palpite errado não conta como
// tentativa de ninguém). Devolve a linha que bateu, ou null. Cada erro soma uma tentativa em
// todas as candidatas com código ativo; ao chegar no limite o código é apagado.
async function conferirCodigo(tabela, candidatas, codigo) {
  const ativas = (candidatas || []).filter(aindaValido);
  const certa = ativas.find((l) => iguais(l.codigo_verificacao, codigo));
  if (certa) return certa;

  await Promise.all(ativas.map((l) => {
    const tentativas = (l.codigo_tentativas || 0) + 1;
    const atualizacao = tentativas >= MAX_TENTATIVAS ? { ...CAMPOS_LIMPOS, codigo_tentativas: tentativas } : { codigo_tentativas: tentativas };
    return supabase.from(tabela).update(atualizacao).eq('id', l.id);
  }));
  return null;
}

module.exports = { VALIDADE_MINUTOS, MAX_TENTATIVAS, gerarCodigo, camposNovoCodigo, conferirCodigo, CAMPOS_LIMPOS, iguais };
