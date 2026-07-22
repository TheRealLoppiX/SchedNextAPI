// Adapter de envio de WhatsApp via Evolution API (self-hosted, protocolo não-oficial do
// WhatsApp Web/Baileys). Trocado da Meta Cloud API em 2026-07-22: a Business Verification da
// Meta exige CNPJ ativo, que o usuário não tem, e não existe caminho oficial pra pessoa física
// (ver handoff.md). Ainda é um único número pra toda a plataforma, igual era com a Meta — virar
// uma instância por empresa fica pra quando o bot for oferecido pra outros clientes de verdade.
// Até EVOLUTION_API_URL/EVOLUTION_API_KEY/EVOLUTION_INSTANCE estarem configurados, só loga a
// mensagem que teria sido enviada, o que dá pra testar a máquina de estados sem depender do VPS.

function estaConfigurado() {
  return Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE);
}

async function enviarMensagem(telefone, texto) {
  if (!estaConfigurado()) {
    console.log(`[WhatsApp simulado] Para ${telefone}: ${texto}`);
    return { enviado: false, simulado: true };
  }

  const resposta = await fetch(
    `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
    {
      method: 'POST',
      headers: {
        apikey: process.env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: telefone.replace(/\D/g, ''), // Evolution espera só dígitos, com DDI
        text: texto,
      }),
    }
  );

  const dados = await resposta.json();

  if (!resposta.ok) {
    console.error('Erro ao enviar WhatsApp via Evolution API:', dados);
    return { enviado: false, erro: dados };
  }

  return { enviado: true, id: dados.key?.id };
}

module.exports = { estaConfigurado, enviarMensagem };
