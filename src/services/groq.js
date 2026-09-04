// Adapter fino sobre a API da Groq (compatível com o formato da OpenAI). Recurso de IA
// gated pro plano Profissional/Enterprise (>R$100/mês, ver planos_plataforma.permite_ia).
// Usa fetch puro (já disponível nativamente no Node) em vez de instalar o SDK da Groq,
// mesmo padrão dos outros adapters do projeto (pagamento.js, whatsapp/provider.js).
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Llama 3.3 70B Versatile foi descontinuado pela Groq em 16/08/2026 — Qwen3.6 27B é o
// substituto recomendado por eles pra workloads de produção.
// Qwen3.6 27B também foi descontinuado, na data 02/09/2026, seguimos com Qwen3.8 27B
const MODELO_PADRAO = 'qwen/qwen3.8-27b';

function estaConfigurado() {
  return Boolean(process.env.GROQ_API_KEY);
}

async function gerarTexto({ prompt, sistema, maxTokens = 400, temperatura = 0.6 }) {
  if (!estaConfigurado()) {
    const erro = new Error('GROQ_API_KEY não configurada.');
    erro.naoConfigurado = true;
    throw erro;
  }

  const resposta = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODELO_PADRAO,
      messages: [
        ...(sistema ? [{ role: 'system', content: sistema }] : []),
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTokens,
      temperature: temperatura,
      // Qwen3 é um modelo de raciocínio: sem isso ele devolve o <think>...</think>
      // junto no content e vaza pro usuário final.
      reasoning_format: 'hidden'
    })
  });

  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    throw new Error(`Groq respondeu ${resposta.status}: ${detalhe}`);
  }

  const dados = await resposta.json();
  const texto = dados.choices?.[0]?.message?.content?.trim() || '';
  // Rede de segurança: remove bloco de raciocínio caso reasoning_format não seja
  // respeitado (ex.: modelo trocado no futuro por outro que não suporte o parâmetro).
  return texto.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Chat completion genérico com suporte a tool calling (function calling), usado pelo modo
// "livre" do bot de WhatsApp (ver services/whatsapp/agente.js) — diferente de gerarTexto (que só
// devolve texto), aqui o chamador precisa do array de tool_calls cru pra decidir o que executar.
// `mensagens` já vem no formato OpenAI (role/content, incluindo role:'tool' das respostas de
// chamadas anteriores) — quem monta o histórico é o chamador.
async function chat({ mensagens, sistema, temperatura = 0.6, maxTokens = 700, tools }) {
  if (!estaConfigurado()) {
    const erro = new Error('GROQ_API_KEY não configurada.');
    erro.naoConfigurado = true;
    throw erro;
  }

  const resposta = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODELO_PADRAO,
      messages: [...(sistema ? [{ role: 'system', content: sistema }] : []), ...mensagens],
      max_tokens: maxTokens,
      temperature: temperatura,
      reasoning_format: 'hidden',
      ...(tools ? { tools, tool_choice: 'auto' } : {})
    })
  });

  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    throw new Error(`Groq respondeu ${resposta.status}: ${detalhe}`);
  }

  const dados = await resposta.json();
  const mensagem = dados.choices?.[0]?.message || {};
  const conteudo = (mensagem.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { content: conteudo, toolCalls: mensagem.tool_calls || null };
}

module.exports = { estaConfigurado, gerarTexto, chat };
