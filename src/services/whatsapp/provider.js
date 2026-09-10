// Adapter de envio de WhatsApp via Evolution API (self-hosted, protocolo não-oficial do
// WhatsApp Web/Baileys). Trocado da Meta Cloud API em 2026-07-22: a Business Verification da
// Meta exige CNPJ ativo, que o usuário não tem, e não existe caminho oficial pra pessoa física
// (ver handoff.md). Cada empresa tem sua própria instância (número de WhatsApp) na mesma
// Evolution API self-hosted — o nome da instância fica em `empresas.whatsapp_phone_number_id`
// (coluna reaproveitada da era Meta) e é sempre passado explicitamente pra essas funções, nunca
// lido de env var. EVOLUTION_API_URL/EVOLUTION_API_KEY continuam globais (é o mesmo servidor
// Evolution/VPS pra toda a plataforma, só a instância dentro dele muda por empresa).

function estaConfigurado() {
  return Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY);
}

function headers() {
  return { apikey: process.env.EVOLUTION_API_KEY, 'Content-Type': 'application/json' };
}

// `instancia` vem de `empresas.whatsapp_phone_number_id` — null enquanto a empresa não conectou
// nenhum WhatsApp ainda (ver routes/whatsappInstancia.js). Sem instância ou sem o servidor
// Evolution configurado, só loga a mensagem que teria sido enviada (permite testar a máquina de
// estados do bot sem depender da VPS).
//
// Só texto puro de propósito: botões/lista interativos nativos (sendButtons/sendList) foram
// tentados e removidos em 2026-09-03 — testado em produção, a Evolution/WhatsApp confirma o envio
// (sem erro, sem fallback disparado) mas o aparelho do cliente não renderiza nada, mensagem
// silenciosamente perdida. Limitação conhecida do protocolo não-oficial (Baileys) em contas
// pessoais, não algo corrigível ajustando o payload.
async function enviarMensagem(instancia, telefone, texto) {
  if (!instancia || !estaConfigurado()) {
    console.log(`[WhatsApp simulado] instancia=${instancia || 'nenhuma'} para ${telefone}: ${texto}`);
    return { enviado: false, simulado: true };
  }

  const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${instancia}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      number: telefone.replace(/\D/g, ''), // Evolution espera só dígitos, com DDI
      text: texto,
    }),
  });

  const dados = await resposta.json();

  if (!resposta.ok) {
    console.error('Erro ao enviar WhatsApp via Evolution API:', dados);
    return { enviado: false, erro: dados };
  }

  return { enviado: true, id: dados.key?.id };
}

// Envia imagem (usado hoje só pro QR Code do Pix de agendamento, ver services/whatsapp/bot.js).
// Diferente dos botões/lista nativos (ver comentário de enviarMensagem acima), mídia comum
// (imagem/documento) é um recurso básico do protocolo Baileys, não uma extensão do WhatsApp
// Business — funciona normalmente em conta pessoal.
async function enviarImagem(instancia, telefone, base64, legenda) {
  if (!instancia || !estaConfigurado()) {
    console.log(`[WhatsApp simulado] imagem para ${telefone}: ${legenda || '(sem legenda)'}`);
    return { enviado: false, simulado: true };
  }

  const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendMedia/${instancia}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      number: telefone.replace(/\D/g, ''),
      mediatype: 'image',
      mimetype: 'image/png',
      fileName: 'pix.png',
      caption: legenda || '',
      media: base64,
    }),
  });

  const dados = await resposta.json();

  if (!resposta.ok) {
    console.error('Erro ao enviar imagem via Evolution API:', dados);
    return { enviado: false, erro: dados };
  }

  return { enviado: true, id: dados.key?.id };
}

// Cria a instância na Evolution API pra uma empresa e já registra o webhook de recebimento
// (ver routes/whatsapp.js). `qrcode: true` faz a Evolution já devolver o QR Code de pareamento
// na própria resposta de criação, sem precisar de uma segunda chamada.
async function criarInstancia(instancia) {
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;

  const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/instance/create`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      instanceName: instancia,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      // Evolution normaliza o nome do evento pra maiúsculo+underscore ("messages.upsert"
      // -> "MESSAGES_UPSERT") antes de checar se está na lista de eventos inscritos do
      // webhook — registrar em minúsculo/com ponto faz essa checagem nunca bater, e o
      // disparo é pulado em silêncio (sem erro, sem log, sem retry).
      webhook: { url: `${backendUrl}/whatsapp/webhook`, events: ['MESSAGES_UPSERT'] },
    }),
  });

  const dados = await resposta.json();
  if (!resposta.ok) throw new Error(dados?.response?.message?.[0] || dados?.message || 'Erro ao criar instância no Evolution API.');
  return dados;
}

// QR Code de pareamento — usado tanto logo após criar a instância quanto pra gerar um novo QR
// se o anterior expirar antes do dono da empresa escanear (o QR do Baileys dura pouco).
async function obterQrCode(instancia) {
  const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/instance/connect/${instancia}`, {
    headers: headers(),
  });
  const dados = await resposta.json();
  if (!resposta.ok) throw new Error(dados?.message || 'Erro ao gerar QR Code.');
  return dados; // { base64, code, count, ... } ou {count} se já conectado/sem QR pendente
}

async function obterStatusConexao(instancia) {
  const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/instance/connectionState/${instancia}`, {
    headers: headers(),
  });
  const dados = await resposta.json();
  if (!resposta.ok) return { state: 'close' };
  return dados?.instance || { state: 'close' };
}

// Apaga de vez a instância na Evolution (não só desconecta) — desvincular e reconectar depois
// com outro número passa a exigir escanear QR de novo, o que é o comportamento esperado.
//
// A Evolution recusa apagar uma instância ainda com o WhatsApp conectado (o delete falha em
// silêncio do ponto de vista do admin, já que o caller só loga o erro e segue limpando nosso
// banco mesmo assim — ver routes/whatsappInstancia.js) — por isso desloga primeiro. Erro no
// logout é ignorado de propósito: se já estiver desconectada (ex: caiu sozinha), o logout falha
// mas o delete em seguida funciona normalmente.
async function removerInstancia(instancia) {
  await fetch(`${process.env.EVOLUTION_API_URL}/instance/logout/${instancia}`, {
    method: 'DELETE',
    headers: headers(),
  }).catch(() => {});

  const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/instance/delete/${instancia}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!resposta.ok && resposta.status !== 404) {
    const dados = await resposta.json().catch(() => ({}));
    throw new Error(dados?.response?.message?.[0] || dados?.message || 'Erro ao remover instância.');
  }
}

module.exports = { estaConfigurado, enviarMensagem, enviarImagem, criarInstancia, obterQrCode, obterStatusConexao, removerInstancia };
