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

// Botões/lista interativos (estilo "banco do brasil"). Como a instância é Baileys (protocolo não-
// oficial), não há garantia de que todo aparelho renderize a UI tocável — por isso `texto` (o corpo
// da mensagem) sempre traz a listagem numerada por extenso também, igual o menu de texto puro:
// mesmo se os botões não aparecerem, o cliente ainda consegue responder digitando o número. Se a
// chamada em si falhar (rede, instância desconectada etc.), cai pro sendText comum.
async function enviarBotoes(instancia, telefone, texto, botoes, footerText) {
  if (!instancia || !estaConfigurado()) {
    console.log(`[WhatsApp simulado] instancia=${instancia || 'nenhuma'} para ${telefone} (botões): ${texto}`);
    return { enviado: false, simulado: true };
  }

  try {
    const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendButtons/${instancia}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        number: telefone.replace(/\D/g, ''),
        text: texto,
        footerText: footerText || 'SchedNext',
        // Evolution API exige "type" em cada botão desde a v2 (schema antigo com
        // buttonId/buttonText aninhado passou a dar 400 "requires property type").
        buttons: botoes.map((b) => ({ type: 'reply', displayText: b.titulo, id: b.id })),
      }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados?.response?.message?.[0] || dados?.message || 'Falha ao enviar botões.');
    return { enviado: true, id: dados.key?.id };
  } catch (err) {
    console.error('Erro ao enviar botões via Evolution API, caindo pro texto simples:', err);
    return enviarMensagem(instancia, telefone, texto);
  }
}

// Lista suspensa (até 10 opções); mesma lógica de fallback de enviarBotoes acima.
async function enviarLista(instancia, telefone, texto, botaoTexto, opcoes) {
  if (!instancia || !estaConfigurado()) {
    console.log(`[WhatsApp simulado] instancia=${instancia || 'nenhuma'} para ${telefone} (lista): ${texto}`);
    return { enviado: false, simulado: true };
  }

  try {
    const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendList/${instancia}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        number: telefone.replace(/\D/g, ''),
        title: 'SchedNext',
        description: texto,
        buttonText: botaoTexto || 'Escolher',
        sections: [
          {
            title: 'Opções',
            rows: opcoes.map((o) => ({ rowId: o.id, title: o.titulo, description: o.descricao || '' })),
          },
        ],
      }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados?.response?.message?.[0] || dados?.message || 'Falha ao enviar lista.');
    return { enviado: true, id: dados.key?.id };
  } catch (err) {
    console.error('Erro ao enviar lista via Evolution API, caindo pro texto simples:', err);
    return enviarMensagem(instancia, telefone, texto);
  }
}

// Escolhe automaticamente botões (WhatsApp não aceita mais que 3) ou lista (até 10); acima disso
// não há suporte nativo, então manda só o texto puro mesmo (que já traz a listagem numerada).
async function enviarMenu(instancia, telefone, texto, opcoes, botaoTexto) {
  if (!opcoes || opcoes.length === 0) return enviarMensagem(instancia, telefone, texto);
  if (opcoes.length <= 3) return enviarBotoes(instancia, telefone, texto, opcoes);
  if (opcoes.length <= 10) return enviarLista(instancia, telefone, texto, botaoTexto, opcoes);
  return enviarMensagem(instancia, telefone, texto);
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
      webhook: { url: `${backendUrl}/whatsapp/webhook`, events: ['messages.upsert'] },
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
async function removerInstancia(instancia) {
  const resposta = await fetch(`${process.env.EVOLUTION_API_URL}/instance/delete/${instancia}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!resposta.ok && resposta.status !== 404) {
    const dados = await resposta.json().catch(() => ({}));
    throw new Error(dados?.response?.message?.[0] || dados?.message || 'Erro ao remover instância.');
  }
}

module.exports = { estaConfigurado, enviarMensagem, enviarMenu, criarInstancia, obterQrCode, obterStatusConexao, removerInstancia };
