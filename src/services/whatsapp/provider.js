// Adapter de envio de WhatsApp via Meta Cloud API oficial (decisão final em 2026-07-21, ver
// handoff.md; chegou a ser tentado o Twilio como BSP, mas o Sender de produção lá é pago, e a
// Meta Cloud API direta é gratuita até ~1000 conversas/mês). Usa a Graph API direto via fetch,
// sem SDK. Até WHATSAPP_PROVIDER_TOKEN/WHATSAPP_PHONE_NUMBER_ID estarem configurados, o
// provider só loga a mensagem que teria sido enviada, o que dá pra testar a máquina de estados
// inteira sem depender de credenciais externas.

const GRAPH_API_VERSION = 'v21.0';

function estaConfigurado() {
  return Boolean(process.env.WHATSAPP_PROVIDER_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function enviarMensagem(telefone, texto) {
  if (!estaConfigurado()) {
    console.log(`[WhatsApp simulado] Para ${telefone}: ${texto}`);
    return { enviado: false, simulado: true };
  }

  const resposta = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_PROVIDER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: telefone.replace(/\D/g, ''), // Meta espera número sem "+"/formatação, só dígitos
        type: 'text',
        text: { body: texto },
      }),
    }
  );

  const dados = await resposta.json();

  if (!resposta.ok) {
    console.error('Erro ao enviar WhatsApp via Meta Cloud API:', dados);
    return { enviado: false, erro: dados };
  }

  return { enviado: true, id: dados.messages?.[0]?.id };
}

module.exports = { estaConfigurado, enviarMensagem };
