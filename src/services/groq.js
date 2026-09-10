// Adapter fino sobre a API da Groq (compatível com o formato da OpenAI). Recurso de IA
// gated pro plano Profissional/Enterprise (>R$100/mês, ver planos_plataforma.permite_ia).
// Usa fetch puro (já disponível nativamente no Node) em vez de instalar o SDK da Groq,
// mesmo padrão dos outros adapters do projeto (pagamento.js, whatsapp/provider.js).
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Llama 3.3 70B Versatile foi descontinuado pela Groq em 16/08/2026 — Qwen3.6 27B é o
// substituto recomendado por eles pra workloads de produção.
// Qwen3.6 27B também foi descontinuado, na data 02/09/2026, seguimos com Qwen3.8 27B
const MODELO_PADRAO = 'qwen/qwen3.8-27b';
// A Groq limita tokens/minuto por MODELO (não por chave de API — testado: gerar uma chave nova não
// dá cota separada), então cada um destes tem seu próprio teto independente. gpt-oss-20b: só
// validado pra classificação de intenção (tarefa curta e disciplinada — responde uma palavra).
// gpt-oss-120b: validado com tool calling de ponta a ponta (ver services/whatsapp/agente.js) —
// mesma qualidade do Qwen nesse uso, e mediu menos da metade dos tokens por conversa. Nenhum dos
// dois foi validado pra reescrever texto livre (comPersonalidade em whatsapp/bot.js): num teste,
// gpt-oss-20b devolveu resposta vazia ou colou emoji fora de contexto — essa tarefa continua só
// no Qwen até validar outro modelo especificamente pra ela.
const MODELO_CLASSIFICACAO = 'openai/gpt-oss-20b';
const MODELO_AGENTE = 'openai/gpt-oss-120b';

// Cadeias de fallback: tenta o primeiro modelo da lista, e só cai pro próximo se ESSE especificamente
// estiver com o teto de tokens/minuto estourado (HTTP 429) — qualquer outro erro (chave inválida,
// 5xx, etc) sobe direto, já que trocar de modelo não resolveria a causa. Cada modelo tem cota
// própria, então normalmente ninguém precisa do fallback; ele só entra quando uma sequência de
// mensagens rápidas esgota a cota do modelo principal daquela tarefa específica — na próxima
// mensagem o principal já volta a ser tentado primeiro (não existe "período de resfriamento"
// guardado em memória, cada chamada tenta o principal de novo do zero).
const MODELOS_TOOL_CALLING = [MODELO_AGENTE, MODELO_PADRAO];
const MODELOS_CLASSIFICACAO = [MODELO_CLASSIFICACAO, MODELO_PADRAO];

function estaConfigurado() {
  return Boolean(process.env.GROQ_API_KEY);
}

// Faz a chamada em si, tentando cada modelo de `modelos` em ordem — só avança pro próximo em caso
// de 429 (rate limit) desse modelo específico; qualquer outro erro (rede, 4xx que não seja rate
// limit, 5xx) é jogado direto pra quem chamou, sem tentar mais nada da lista.
async function chamarComFallback(modelos, corpoBase) {
  let ultimoErro;
  for (const modelo of modelos) {
    let resposta;
    try {
      resposta = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...corpoBase, model: modelo })
      });
    } catch (err) {
      throw err; // falha de rede não tem a ver com qual modelo — não adianta trocar
    }

    if (resposta.status === 429) {
      ultimoErro = new Error(`Groq respondeu 429 (limite de tokens/minuto) no modelo ${modelo}.`);
      continue;
    }
    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      throw new Error(`Groq respondeu ${resposta.status}: ${detalhe}`);
    }
    return resposta.json();
  }
  throw ultimoErro;
}

async function gerarTexto({ prompt, sistema, maxTokens = 400, temperatura = 0.6, reasoningEffort, modelos = [MODELO_PADRAO] }) {
  if (!estaConfigurado()) {
    const erro = new Error('GROQ_API_KEY não configurada.');
    erro.naoConfigurado = true;
    throw erro;
  }

  const dados = await chamarComFallback(modelos, {
    messages: [
      ...(sistema ? [{ role: 'system', content: sistema }] : []),
      { role: 'user', content: prompt }
    ],
    max_tokens: maxTokens,
    temperature: temperatura,
    // Qwen3 é um modelo de raciocínio: sem isso ele devolve o <think>...</think>
    // junto no content e vaza pro usuário final.
    reasoning_format: 'hidden',
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
  });

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
async function chat({ mensagens, sistema, temperatura = 0.6, maxTokens = 700, tools, reasoningEffort, modelos = [MODELO_PADRAO] }) {
  if (!estaConfigurado()) {
    const erro = new Error('GROQ_API_KEY não configurada.');
    erro.naoConfigurado = true;
    throw erro;
  }

  const dados = await chamarComFallback(modelos, {
    messages: [...(sistema ? [{ role: 'system', content: sistema }] : []), ...mensagens],
    max_tokens: maxTokens,
    temperature: temperatura,
    reasoning_format: 'hidden',
    // NÃO force reasoning_effort aqui sem testar de novo com tool calling: medimos direto na
    // API que passar "none" (ou mesmo "low") no Qwen faz ele parar de chamar ferramenta antes de
    // responder — chegou a inventar um serviço que não existe no banco em vez de checar com
    // listar_opcoes. Sem o parâmetro é o único jeito validado que mantém o tool calling confiável
    // nos modelos usados aqui.
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools ? { tools, tool_choice: 'auto' } : {})
  });

  const mensagem = dados.choices?.[0]?.message || {};
  const conteudo = (mensagem.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return { content: conteudo, toolCalls: mensagem.tool_calls || null };
}

module.exports = { estaConfigurado, gerarTexto, chat, MODELOS_CLASSIFICACAO, MODELOS_TOOL_CALLING };
