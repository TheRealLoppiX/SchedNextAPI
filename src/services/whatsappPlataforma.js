const supabase = require('../config/supabase');
const { enviarMensagem, estaConfigurado } = require('./whatsapp/provider');

// WhatsApp próprio da SchedNext, pra falar com as EMPRESAS (cobrança, avisos). Diferente da
// instância de cada empresa (empresas.whatsapp_phone_number_id), que fala com os clientes dela.
// O nome da instância fica em plataforma_configuracoes ('whatsapp_instancia_plataforma'), gravado
// quando o admin absoluto conecta o número (ver routes/superAdminFinanceiro.js).
const CHAVE_INSTANCIA = 'whatsapp_instancia_plataforma';
const NOME_INSTANCIA = 'schednext-plataforma';

async function obterInstanciaPlataforma() {
  const { data } = await supabase.from('plataforma_configuracoes').select('valor').eq('chave', CHAVE_INSTANCIA).maybeSingle();
  return data?.valor || null;
}

// Telefone salvo sem DDI (cadastro da empresa); a Evolution espera com 55.
function normalizarTelefone(telefone) {
  let numero = String(telefone || '').replace(/\D/g, '');
  if (numero.length === 10 || numero.length === 11) numero = `55${numero}`;
  return numero.length >= 12 && numero.length <= 13 ? numero : null;
}

// Best-effort: sem instância conectada ou sem telefone, devolve false sem erro (o e-mail e o
// aviso no painel continuam valendo).
async function enviarWhatsappPlataforma(telefone, texto) {
  const numero = normalizarTelefone(telefone);
  if (!numero || !estaConfigurado()) return false;
  const instancia = await obterInstanciaPlataforma();
  if (!instancia) return false;
  try {
    await enviarMensagem(instancia, numero, texto);
    return true;
  } catch (err) {
    console.error('Erro ao enviar WhatsApp da plataforma:', err.message || err);
    return false;
  }
}

module.exports = { CHAVE_INSTANCIA, NOME_INSTANCIA, obterInstanciaPlataforma, enviarWhatsappPlataforma };
