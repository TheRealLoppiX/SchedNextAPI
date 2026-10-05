const supabase = require('../config/supabase');
const { enviarMensagem, estaConfigurado, obterStatusConexao } = require('./whatsapp/provider');

// Prospecção de clientes por WhatsApp (admin absoluto): a SchedNext aborda negócios de uma lista
// importada de planilha, num ritmo diário configurável. Usa uma instância de WhatsApp PRÓPRIA,
// separada da de cobrança (whatsappPlataforma.js): mensagem fria pelo protocolo não-oficial é o
// que mais leva número a ser banido, e um banimento aqui não pode derrubar a cobrança.
//
// Fluxo de cada prospect: na_fila -> abertura_enviada -> (dias_followup sem resposta)
// followup_enviado -> (dias_followup sem resposta) sem_resposta. Qualquer resposta tira da
// automação (respondeu/optout) e avisa o admin — a conversa segue manual, no celular.

const CHAVE_INSTANCIA = 'whatsapp_instancia_prospeccao';
const NOME_INSTANCIA = 'schednext-prospeccao';
const CHAVE_CONFIG = 'prospeccao_config';
const CHAVE_PROXIMO_ENVIO = 'prospeccao_proximo_envio_em';
const FUSO = 'America/Sao_Paulo';
const UM_DIA_MS = 24 * 60 * 60 * 1000;

const CONFIG_PADRAO = {
  ativo: false,
  limite_diario: 15,
  intervalo_min_minutos: 4,
  intervalo_max_minutos: 10,
  // 0 = domingo ... 6 = sábado. Padrão terça a quinta, como no roteiro de prospecção.
  dias_semana: [2, 3, 4],
  // Uma ou mais faixas "HH:MM-HH:MM" separadas por vírgula, no horário de Brasília.
  janelas: '09:00-11:00, 14:00-16:30',
  enviar_followup: true,
  dias_followup: 3,
  usar_mensagens_planilha: true,
  ajustar_saudacao: true,
  mensagens_abertura: [
    'Olá, {saudacao}! Tudo bem? Sou o Rafael, da SchedNext. Vi a {empresa} no Google e as avaliações dos clientes são ótimas.\n\nEstou ajudando negócios aqui de {cidade} a organizar a agenda e queria te fazer uma pergunta rápida: hoje vocês marcam os horários como?',
    'Oi, {saudacao}! Aqui é o Rafael, da SchedNext. Uma dúvida rápida sobre a {empresa}: quem responde o WhatsApp pra marcar horário? Você mesmo(a), no meio do atendimento?',
    'Oi, {saudacao}! Sou o Rafael e estou fazendo uma pesquisa rápida com negócios de {cidade}: hoje, qual é a parte mais chata de organizar a agenda de vocês?'
  ],
  mensagem_followup: 'Passando só pra não deixar a mensagem se perder, sei que a rotina é corrida. Se fizer sentido, te mando um vídeo de 1 minuto mostrando como funciona. Se não for o momento, sem problema nenhum.',
  palavras_optout: 'sair, parar, pare, stop, remover, descadastrar',
  resposta_optout: 'Tudo bem, não vou mais te enviar mensagens. Obrigado e bom trabalho!',
  numero_aviso: ''
};

const PRIORIDADE_ORDEM = { alta: 1, media: 2, baixa: 3 };

// ---------------------------------------------------------------- configuração e instância

async function lerChave(chave) {
  const { data } = await supabase.from('plataforma_configuracoes').select('valor').eq('chave', chave).maybeSingle();
  return data?.valor ?? null;
}

async function gravarChave(chave, valor) {
  const { error } = await supabase
    .from('plataforma_configuracoes')
    .upsert({ chave, valor, atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
  if (error) throw error;
}

async function carregarConfig() {
  const bruto = await lerChave(CHAVE_CONFIG);
  let salvo = {};
  try { salvo = bruto ? JSON.parse(bruto) : {}; } catch { salvo = {}; }
  return { ...CONFIG_PADRAO, ...salvo };
}

async function salvarConfig(config) {
  const atual = await carregarConfig();
  const nova = { ...atual, ...config };
  await gravarChave(CHAVE_CONFIG, JSON.stringify(nova));
  return nova;
}

// Cache curto porque o webhook consulta isso a cada mensagem recebida de qualquer empresa.
let cacheInstancia = { valor: null, ate: 0 };
async function obterInstanciaProspeccao({ semCache = false } = {}) {
  if (!semCache && Date.now() < cacheInstancia.ate) return cacheInstancia.valor;
  const valor = await lerChave(CHAVE_INSTANCIA);
  cacheInstancia = { valor, ate: Date.now() + 60 * 1000 };
  return valor;
}

async function definirInstanciaProspeccao(instancia) {
  if (instancia) await gravarChave(CHAVE_INSTANCIA, instancia);
  else await supabase.from('plataforma_configuracoes').delete().eq('chave', CHAVE_INSTANCIA);
  cacheInstancia = { valor: instancia || null, ate: Date.now() + 60 * 1000 };
}

// ---------------------------------------------------------------- telefone

// Só celular brasileiro entra na fila: fixo não tem WhatsApp (ou é WhatsApp Business em fixo,
// raro o bastante pra não valer o envio às cegas). Devolve só dígitos com 55 e o 9, ou null.
function normalizarCelular(telefone) {
  let n = String(telefone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (n.length === 10 || n.length === 11) n = `55${n}`;
  if (!n.startsWith('55')) return null;
  const ddd = n.slice(2, 4);
  let resto = n.slice(4);
  if (resto.length === 8 && /^[6-9]/.test(resto)) resto = `9${resto}`; // celular antigo sem o 9
  if (resto.length !== 9 || !resto.startsWith('9') || Number(ddd) < 11) return null;
  return `55${ddd}${resto}`;
}

// O WhatsApp às vezes identifica o mesmo celular sem o 9 (JID antigo de alguns DDDs), então a
// resposta pode chegar como 554199998888 pra um prospect gravado como 5541999998888.
function variantesTelefone(numero) {
  const n = String(numero || '').replace(/\D/g, '');
  const variantes = new Set([n]);
  if (n.length === 13 && n[4] === '9') variantes.add(n.slice(0, 4) + n.slice(5));
  if (n.length === 12) variantes.add(`${n.slice(0, 4)}9${n.slice(4)}`);
  return [...variantes];
}

// ---------------------------------------------------------------- horário

function agoraBrasilia(data = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: FUSO, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(data).map((p) => [p.type, p.value])
  );
  const diaSemana = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes.weekday);
  return {
    diaSemana,
    minutos: Number(partes.hour) * 60 + Number(partes.minute),
    hora: Number(partes.hour),
    dataISO: `${partes.year}-${partes.month}-${partes.day}`
  };
}

function lerJanelas(texto) {
  return String(texto || '')
    .split(',')
    .map((faixa) => faixa.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/))
    .filter(Boolean)
    .map(([, h1, m1, h2, m2]) => ({ inicio: Number(h1) * 60 + Number(m1), fim: Number(h2) * 60 + Number(m2) }))
    .filter((j) => j.fim > j.inicio);
}

function dentroDaJanela(config, agora = agoraBrasilia()) {
  if (!(config.dias_semana || []).includes(agora.diaSemana)) return false;
  return lerJanelas(config.janelas).some((j) => agora.minutos >= j.inicio && agora.minutos < j.fim);
}

// Meia-noite de hoje em Brasília (UTC-3, sem horário de verão desde 2019) — base da contagem
// "enviadas hoje" do limite diário.
const inicioDoDiaBrasilia = (agora = agoraBrasilia()) => new Date(`${agora.dataISO}T00:00:00-03:00`);

// ---------------------------------------------------------------- texto

function saudacaoPorHora(hora) {
  if (hora < 12) return 'bom dia';
  if (hora < 18) return 'boa tarde';
  return 'boa noite';
}

const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function montarTexto(modelo, prospect, config, agora = agoraBrasilia()) {
  const saudacao = saudacaoPorHora(agora.hora);
  let texto = String(modelo || '')
    .replace(/\{saudacao\}/g, saudacao)
    .replace(/\{Saudacao\}/g, maiuscula(saudacao))
    .replace(/\{empresa\}/g, prospect.empresa || 'seu negócio')
    .replace(/\{cidade\}/g, prospect.cidade || 'sua cidade')
    .replace(/\{bairro\}/g, prospect.bairro || prospect.cidade || 'sua região')
    .replace(/\{categoria\}/g, (prospect.categoria || 'negócio').toLowerCase());
  // Mensagem da planilha foi escrita com "bom dia" fixo: troca pela saudação da hora do envio,
  // mantendo a maiúscula de quem escreveu.
  if (config.ajustar_saudacao) {
    texto = texto.replace(/\b(bom dia|boa tarde|boa noite)\b/gi, (achado) => (achado[0] === achado[0].toUpperCase() ? maiuscula(saudacao) : saudacao));
  }
  return texto.trim();
}

function modeloAbertura(prospect, config) {
  if (config.usar_mensagens_planilha && prospect.mensagem_abertura) return prospect.mensagem_abertura;
  const modelos = (config.mensagens_abertura || []).filter((m) => m && m.trim());
  if (!modelos.length) return null;
  const indiceVariante = { A: 0, B: 1, C: 2 }[String(prospect.variante || '').trim().toUpperCase()];
  if (indiceVariante !== undefined && modelos[indiceVariante]) return modelos[indiceVariante];
  return modelos[Number(prospect.id) % modelos.length];
}

function modeloFollowup(prospect, config) {
  if (config.usar_mensagens_planilha && prospect.mensagem_followup) return prospect.mensagem_followup;
  return config.mensagem_followup || null;
}

// ---------------------------------------------------------------- motor de envio

async function contarEnviadasHoje() {
  const { count } = await supabase
    .from('prospeccao_envios')
    .select('id', { count: 'exact', head: true })
    .eq('ok', true)
    .gt('etapa', 0)
    .gte('enviado_em', inicioDoDiaBrasilia().toISOString());
  return count || 0;
}

// Quem já recebeu a última mensagem e não respondeu em dias_followup sai da fila de vez.
async function encerrarSemResposta(config) {
  const limite = new Date(Date.now() - config.dias_followup * UM_DIA_MS).toISOString();
  const statusFinal = config.enviar_followup ? ['followup_enviado'] : ['abertura_enviada', 'followup_enviado'];
  await supabase.from('prospects').update({ status: 'sem_resposta' }).in('status', statusFinal).lte('ultimo_envio_em', limite);
}

// Follow-up vencido tem prioridade sobre abertura nova: senão quem já recebeu a primeira
// mensagem ficaria esperando a fila inteira acabar.
async function escolherProximo(config) {
  if (config.enviar_followup) {
    const limite = new Date(Date.now() - config.dias_followup * UM_DIA_MS).toISOString();
    const { data } = await supabase
      .from('prospects')
      .select('*')
      .eq('status', 'abertura_enviada')
      .lte('ultimo_envio_em', limite)
      .order('ultimo_envio_em', { ascending: true })
      .limit(1);
    if (data?.[0]) return { prospect: data[0], etapa: 2 };
  }
  const { data } = await supabase
    .from('prospects')
    .select('*')
    .eq('status', 'na_fila')
    .order('prioridade_ordem', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  return data?.[0] ? { prospect: data[0], etapa: 1 } : null;
}

async function registrarEnvio(prospectId, etapa, texto, erro = null) {
  await supabase.from('prospeccao_envios').insert({ prospect_id: prospectId, etapa, texto, ok: !erro, erro });
}

async function agendarProximoEnvio(config) {
  const min = Math.max(1, Number(config.intervalo_min_minutos) || 1);
  const max = Math.max(min, Number(config.intervalo_max_minutos) || min);
  const minutos = min + Math.random() * (max - min);
  const proximo = new Date(Date.now() + minutos * 60 * 1000).toISOString();
  await gravarChave(CHAVE_PROXIMO_ENVIO, proximo);
  return proximo;
}

// Situação do motor agora, usada tanto pelo cron quanto pelo painel ("por que não está enviando?").
async function situacao(config) {
  if (!config.ativo) return { podeEnviar: false, motivo: 'Disparos pausados.' };
  if (!estaConfigurado()) return { podeEnviar: false, motivo: 'Integração de WhatsApp (Evolution) não configurada no servidor.' };
  const instancia = await obterInstanciaProspeccao();
  if (!instancia) return { podeEnviar: false, motivo: 'Nenhum WhatsApp de prospecção conectado.' };
  if (!dentroDaJanela(config)) return { podeEnviar: false, motivo: 'Fora dos dias/horários de envio configurados.', instancia };
  const enviadasHoje = await contarEnviadasHoje();
  if (enviadasHoje >= config.limite_diario) return { podeEnviar: false, motivo: `Limite diário atingido (${enviadasHoje}/${config.limite_diario}).`, instancia };
  const proximo = await lerChave(CHAVE_PROXIMO_ENVIO);
  if (proximo && new Date(proximo) > new Date()) return { podeEnviar: false, motivo: 'Aguardando o intervalo entre mensagens.', proximoEnvioEm: proximo, instancia };
  return { podeEnviar: true, instancia };
}

// enviarMensagem (provider.js) não lança erro: devolve { enviado: false, erro: <resposta da
// Evolution> }. Número sem WhatsApp vem como response.message = [{ exists: false, ... }].
function descreverErroEnvio(erro) {
  const detalhes = erro?.response?.message;
  if (Array.isArray(detalhes) && detalhes.some((d) => d?.exists === false)) return 'Número sem WhatsApp.';
  if (Array.isArray(detalhes) && typeof detalhes[0] === 'string') return detalhes[0];
  return erro?.message || 'Falha no envio pelo WhatsApp.';
}

let processando = false;

// Chamado a cada minuto pelo cron (ver cron/prospeccao.js). Manda no máximo UMA mensagem por
// chamada: o intervalo aleatório entre envios é o que deixa o ritmo parecido com o de uma pessoa.
async function processarFila() {
  if (processando) return;
  processando = true;
  try {
    const config = await carregarConfig();
    const estado = await situacao(config);
    if (!estado.podeEnviar) return;

    const conexao = await obterStatusConexao(estado.instancia).catch(() => ({ state: 'close' }));
    if (conexao.state !== 'open') return;

    await encerrarSemResposta(config);
    const proximo = await escolherProximo(config);
    if (!proximo) return;

    const { prospect, etapa } = proximo;
    const modelo = etapa === 1 ? modeloAbertura(prospect, config) : modeloFollowup(prospect, config);
    if (!modelo) {
      // Sem mensagem configurada pra essa etapa: tira da fila em vez de travar nela pra sempre.
      await supabase.from('prospects').update({ status: etapa === 1 ? 'erro' : 'sem_resposta', erro: etapa === 1 ? 'Nenhuma mensagem de abertura configurada.' : null }).eq('id', prospect.id);
      return;
    }
    const texto = montarTexto(modelo, prospect, config);

    try {
      const envio = await enviarMensagem(estado.instancia, prospect.telefone, texto);
      if (!envio?.enviado) throw new Error(descreverErroEnvio(envio?.erro));
      await registrarEnvio(prospect.id, etapa, texto);
      await supabase.from('prospects').update({
        status: etapa === 1 ? 'abertura_enviada' : 'followup_enviado',
        mensagens_enviadas: (prospect.mensagens_enviadas || 0) + 1,
        ultimo_envio_em: new Date().toISOString(),
        erro: null
      }).eq('id', prospect.id);
    } catch (err) {
      const mensagem = String(err?.message || err).slice(0, 300);
      await registrarEnvio(prospect.id, etapa, texto, mensagem);
      await supabase.from('prospects').update({ status: 'erro', erro: mensagem }).eq('id', prospect.id);
      console.error(`Prospecção: erro ao enviar para o prospect ${prospect.id}:`, mensagem);
    }
    // Agenda o próximo mesmo depois de erro, pra uma falha em série não virar rajada de tentativas.
    await agendarProximoEnvio(config);
  } catch (err) {
    console.error('Prospecção: erro no processamento da fila:', err.message || err);
  } finally {
    processando = false;
  }
}

// ---------------------------------------------------------------- respostas (webhook)

function ehPedidoDeSaida(texto, config) {
  const normalizar = (t) => String(t || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
  const palavras = String(config.palavras_optout || '').split(',').map(normalizar).filter(Boolean);
  const resposta = normalizar(texto).replace(/[.!?]+$/, '');
  return palavras.includes(resposta);
}

// Chamado pelo webhook (routes/whatsapp.js) pra toda mensagem recebida. Devolve true quando a
// mensagem chegou no WhatsApp de prospecção — aí ela é tratada aqui e não vai pro bot de nenhuma
// empresa.
async function registrarResposta(instancia, telefone, texto) {
  if (!instancia) return false;
  const instanciaProspeccao = await obterInstanciaProspeccao();
  if (!instanciaProspeccao || instancia !== instanciaProspeccao) return false;

  try {
    const { data: candidatos } = await supabase.from('prospects').select('*').in('telefone', variantesTelefone(telefone));
    const prospect = candidatos?.[0];
    if (!prospect || prospect.status === 'optout') return true;

    const config = await carregarConfig();
    const saida = ehPedidoDeSaida(texto, config);
    const primeiraResposta = !['respondeu', 'optout'].includes(prospect.status);

    await supabase.from('prospects').update({
      status: saida ? 'optout' : 'respondeu',
      respondeu_em: prospect.respondeu_em || new Date().toISOString(),
      ultima_resposta: String(texto).slice(0, 1000)
    }).eq('id', prospect.id);

    if (saida && config.resposta_optout) {
      await enviarMensagem(instancia, prospect.telefone, config.resposta_optout)
        .then(() => registrarEnvio(prospect.id, 0, config.resposta_optout))
        .catch((err) => console.error('Prospecção: erro ao confirmar saída:', err.message || err));
    }

    // Aviso pro admin só na primeira resposta, senão cada mensagem da conversa geraria um aviso.
    const numeroAviso = normalizarCelular(config.numero_aviso);
    if (primeiraResposta && numeroAviso) {
      const aviso = saida
        ? `Prospecção: ${prospect.empresa} pediu para não receber mais mensagens.`
        : `Prospecção: ${prospect.empresa} (${prospect.cidade || 'sem cidade'}) respondeu!\n\n"${String(texto).slice(0, 500)}"\n\nContinue a conversa: https://wa.me/${prospect.telefone}`;
      await enviarMensagem(instancia, numeroAviso, aviso).catch((err) => console.error('Prospecção: erro ao avisar o admin:', err.message || err));
    }
  } catch (err) {
    console.error('Prospecção: erro ao registrar resposta:', err.message || err);
  }
  return true;
}

// ---------------------------------------------------------------- importação

const STATUS_PLANILHA_LIVRES = ['', 'a abordar', 'nao contatado', 'novo', 'pendente'];

// linhas: [{ empresa, telefone, categoria, cidade, bairro, instagram, prioridade, ponto_abordagem,
// variante, mensagem_abertura, mensagem_followup, status_planilha }] já mapeadas pelo frontend.
async function importarProspects(linhas, origem) {
  const resultado = { importados: 0, fixos_ou_invalidos: 0, duplicados: 0, ja_contatados: 0, ja_clientes: 0, sem_nome: 0 };
  const normalizarTexto = (t) => String(t || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
  const vazioParaNull = (t) => (t === undefined || t === null || String(t).trim() === '' ? null : String(t).trim());

  // Telefones de quem já é cliente: não faz sentido prospectar quem já usa a SchedNext.
  const { data: empresas } = await supabase.from('empresas').select('telefone').not('telefone', 'is', null);
  const clientes = new Set((empresas || []).map((e) => normalizarCelular(e.telefone)).filter(Boolean));

  const vistos = new Set();
  const novos = [];
  for (const linha of linhas) {
    const empresa = vazioParaNull(linha.empresa);
    if (!empresa) { resultado.sem_nome += 1; continue; }
    const telefone = normalizarCelular(linha.telefone);
    if (!telefone) { resultado.fixos_ou_invalidos += 1; continue; }
    if (!STATUS_PLANILHA_LIVRES.includes(normalizarTexto(linha.status_planilha))) { resultado.ja_contatados += 1; continue; }
    if (clientes.has(telefone)) { resultado.ja_clientes += 1; continue; }
    if (vistos.has(telefone)) { resultado.duplicados += 1; continue; }
    vistos.add(telefone);
    novos.push({
      empresa,
      telefone,
      categoria: vazioParaNull(linha.categoria),
      cidade: vazioParaNull(linha.cidade),
      bairro: vazioParaNull(linha.bairro),
      instagram: vazioParaNull(linha.instagram),
      prioridade: vazioParaNull(linha.prioridade),
      prioridade_ordem: PRIORIDADE_ORDEM[normalizarTexto(linha.prioridade)] || 2,
      ponto_abordagem: vazioParaNull(linha.ponto_abordagem),
      variante: vazioParaNull(linha.variante),
      mensagem_abertura: vazioParaNull(linha.mensagem_abertura),
      mensagem_followup: vazioParaNull(linha.mensagem_followup),
      origem: vazioParaNull(origem)
    });
  }

  // Quem já está na base (de uma importação anterior) não é sobrescrito: o status e o histórico
  // de conversa dele continuam valendo.
  for (let i = 0; i < novos.length; i += 200) {
    const lote = novos.slice(i, i + 200);
    const { data: existentes } = await supabase.from('prospects').select('telefone').in('telefone', lote.map((p) => p.telefone));
    const jaNaBase = new Set((existentes || []).map((p) => p.telefone));
    const inserir = lote.filter((p) => !jaNaBase.has(p.telefone));
    resultado.duplicados += lote.length - inserir.length;
    if (inserir.length) {
      const { error } = await supabase.from('prospects').insert(inserir);
      if (error) throw error;
      resultado.importados += inserir.length;
    }
  }
  return resultado;
}

module.exports = {
  CHAVE_INSTANCIA,
  NOME_INSTANCIA,
  CHAVE_PROXIMO_ENVIO,
  CONFIG_PADRAO,
  lerChave,
  gravarChave,
  carregarConfig,
  salvarConfig,
  obterInstanciaProspeccao,
  definirInstanciaProspeccao,
  normalizarCelular,
  variantesTelefone,
  agoraBrasilia,
  dentroDaJanela,
  lerJanelas,
  montarTexto,
  modeloAbertura,
  contarEnviadasHoje,
  situacao,
  processarFila,
  registrarResposta,
  importarProspects
};
