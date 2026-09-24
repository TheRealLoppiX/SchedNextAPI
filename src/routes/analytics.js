const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../config/supabase');

const router = express.Router();

// Analytics próprio do site institucional (landing, docs, cadastro de empresa, login do admin).
// Ver sql/2026_analytics_funil.sql pro modelo e frontend/src/utils/analytics.js pro lado que
// coleta. Dois pedaços aqui:
//   - POST /analytics/eventos: público, recebe lotes de eventos do navegador (via sendBeacon,
//     por isso aceita text/plain, que não dispara preflight de CORS).
//   - GET /super-admin/analytics/funil: relatório do admin absoluto (funil, canais,
//     localização, cliques, abandono do cadastro), com comparação ao período anterior.

// Generoso de propósito: uma visita normal manda um lote a cada poucos segundos, e várias
// pessoas atrás do mesmo IP (rede de empresa, 4G com CGNAT) somam no mesmo limite.
const eventosLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições.' }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|quora link|pinterest|vkshare|w3c_validator|curl|wget|python-requests|axios/i;
const TIPOS_EVENTO = new Set(['pagina', 'clique', 'evento', 'secao']);
const MAX_EVENTOS_POR_LOTE = 50;

function texto(v, max = 200) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

// O Cloudflare manda cidade/região com acento em UTF-8 cru, e o Node lê header como latin1
// ("SÃ£o Paulo"). Reinterpreta os bytes; se não virar UTF-8 válido, mantém como veio.
function corrigirAcento(valor) {
  if (!valor) return null;
  if (!/[À-ÿ]/.test(valor)) return valor;
  const convertido = Buffer.from(valor, 'latin1').toString('utf8');
  return convertido.includes('�') ? valor : convertido;
}

function hostDe(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; }
}

const BUSCADORES = [
  ['google.', 'google'], ['bing.com', 'bing'], ['duckduckgo.com', 'duckduckgo'], ['yahoo.', 'yahoo'],
  ['ecosia.org', 'ecosia'], ['yandex.', 'yandex'], ['search.brave.com', 'brave'], ['baidu.com', 'baidu']
];
const REDES_SOCIAIS = {
  instagram: ['instagram.com', 'l.instagram.com'],
  facebook: ['facebook.com', 'm.facebook.com', 'l.facebook.com', 'lm.facebook.com', 'fb.com'],
  whatsapp: ['whatsapp.com', 'wa.me', 'web.whatsapp.com'],
  tiktok: ['tiktok.com'],
  linkedin: ['linkedin.com', 'lnkd.in'],
  youtube: ['youtube.com', 'youtu.be'],
  x: ['twitter.com', 't.co', 'x.com'],
  pinterest: ['pinterest.com', 'pin.it'],
  threads: ['threads.net']
};
const MIDIAS_PAGAS = ['cpc', 'ppc', 'paid', 'pago', 'ads', 'paid_social', 'paidsocial', 'display', 'cpm', 'patrocinado'];

function redeSocialDoHost(host) {
  if (!host) return null;
  for (const [rede, hosts] of Object.entries(REDES_SOCIAIS)) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return rede;
  }
  return null;
}

function redeSocialDoNavegador(ua) {
  // Navegador interno dos apps (abrir link da bio/story/anúncio) quase nunca manda referrer,
  // mas se identifica no user-agent.
  if (/Instagram/i.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return 'facebook';
  if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) return 'tiktok';
  if (/LinkedInApp/i.test(ua)) return 'linkedin';
  return null;
}

// Canal (agrupamento amplo) + origem (quem mandou). Prioridade: marcação explícita de campanha
// (utm/clid) > navegador interno de app > referrer > direto.
function classificarOrigem({ referrer, utm_source, utm_medium, tem_clid, ua, host_site }) {
  const fonte = (utm_source || '').toLowerCase();
  const midia = (utm_medium || '').toLowerCase();
  const hostRef = hostDe(referrer);
  const refInterno = hostRef && host_site && (hostRef === host_site || hostRef.endsWith('schednext.com.br'));
  const social = redeSocialDoHost(hostRef) || redeSocialDoNavegador(ua) || (REDES_SOCIAIS[fonte] ? fonte : null);

  if (tem_clid || MIDIAS_PAGAS.includes(midia)) {
    return { canal: 'pago', origem: fonte || social || (hostRef && !refInterno ? hostRef : null) || 'anuncio' };
  }
  if (midia === 'email' || midia === 'e-mail' || fonte === 'email' || fonte === 'newsletter') {
    return { canal: 'email', origem: fonte || 'email' };
  }
  if (social) return { canal: 'social', origem: social };
  if (fonte) return { canal: 'referencia', origem: fonte };
  if (hostRef && !refInterno) {
    const buscador = BUSCADORES.find(([trecho]) => hostRef.includes(trecho));
    if (buscador) return { canal: 'organico', origem: buscador[1] };
    return { canal: 'referencia', origem: hostRef };
  }
  return { canal: 'direto', origem: null };
}

function dispositivoDe(ua, largura) {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'mobile';
  if (largura && largura < 768) return 'mobile';
  return 'desktop';
}

function sistemaDe(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Outro';
}

function navegadorDe(ua) {
  if (/Instagram/i.test(ua)) return 'Instagram (app)';
  if (/FBAN|FBAV/i.test(ua)) return 'Facebook (app)';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/CriOS|Chrome\//i.test(ua)) return 'Chrome';
  if (/FxiOS|Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua)) return 'Safari';
  return 'Outro';
}

router.post('/analytics/eventos', eventosLimiter, express.text({ type: 'text/plain', limit: '100kb' }), async (req, res) => {
  let corpo = req.body;
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch (_) { return res.status(400).end(); }
  }
  const sessao = corpo?.sessao;
  const eventos = Array.isArray(corpo?.eventos) ? corpo.eventos.slice(0, MAX_EVENTOS_POR_LOTE) : [];
  if (!sessao || !UUID_RE.test(sessao.id || '') || !UUID_RE.test(sessao.visitante_id || '') || !eventos.length) {
    return res.status(400).end();
  }

  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_RE.test(ua)) return res.status(204).end();

  const agora = new Date().toISOString();
  const largura = Number.isFinite(Number(sessao.largura_tela)) ? Math.round(Number(sessao.largura_tela)) : null;
  const referrer = texto(sessao.referrer, 500);
  const utm = {
    utm_source: texto(sessao.utm_source, 120),
    utm_medium: texto(sessao.utm_medium, 120),
    utm_campaign: texto(sessao.utm_campaign, 200),
    utm_term: texto(sessao.utm_term, 200),
    utm_content: texto(sessao.utm_content, 200)
  };
  const temClid = Boolean(sessao.tem_clid);
  const { canal, origem } = classificarOrigem({
    referrer, utm_source: utm.utm_source, utm_medium: utm.utm_medium, tem_clid: temClid, ua,
    host_site: hostDe(req.headers.origin || '')
  });
  const pais = texto(req.headers['cf-ipcountry'], 8);

  // Primeiro lote da sessão cria a linha com a atribuição; lotes seguintes só atualizam a
  // última atividade (ignoreDuplicates não sobrescreve a origem da entrada).
  const { error: erroSessao } = await supabase.from('analytics_sessoes').upsert({
    id: sessao.id,
    visitante_id: sessao.visitante_id,
    iniciada_em: agora,
    ultima_atividade: agora,
    canal,
    origem: texto(origem, 120),
    ...utm,
    tem_clid: temClid,
    referrer,
    pagina_entrada: texto(sessao.pagina_entrada, 200),
    dispositivo: dispositivoDe(ua, largura),
    sistema: sistemaDe(ua),
    navegador: navegadorDe(ua),
    largura_tela: largura,
    idioma: texto(sessao.idioma, 20),
    fuso: texto(sessao.fuso, 60),
    pais: pais && pais !== 'XX' && pais !== 'T1' ? pais : null,
    estado: texto(corrigirAcento(req.headers['cf-region']), 80),
    cidade: texto(corrigirAcento(req.headers['cf-ipcity']), 80)
  }, { onConflict: 'id', ignoreDuplicates: true });
  if (erroSessao) {
    console.error('[analytics] erro ao gravar sessão:', erroSessao.message);
    return res.status(500).end();
  }
  await supabase.from('analytics_sessoes').update({ ultima_atividade: agora }).eq('id', sessao.id);

  const linhas = eventos
    .filter((e) => e && TIPOS_EVENTO.has(e.tipo) && texto(e.nome))
    .map((e) => {
      let dados = null;
      if (e.dados && typeof e.dados === 'object') {
        const json = JSON.stringify(e.dados);
        if (json.length <= 1000) dados = e.dados;
      }
      const em = e.em && !Number.isNaN(Date.parse(e.em)) ? new Date(e.em) : null;
      // Relógio do navegador pode estar errado; aceita o horário dele só se estiver perto do
      // horário do servidor (o lote é mandado poucos segundos depois do evento).
      const criadoEm = em && Math.abs(em.getTime() - Date.now()) < 10 * 60 * 1000 ? em.toISOString() : agora;
      return {
        sessao_id: sessao.id,
        tipo: e.tipo,
        nome: texto(e.nome, 120),
        caminho: texto(e.caminho, 200),
        dados,
        criado_em: criadoEm
      };
    });

  if (linhas.length) {
    const { error } = await supabase.from('analytics_eventos').insert(linhas);
    if (error) {
      console.error('[analytics] erro ao gravar eventos:', error.message);
      return res.status(500).end();
    }
  }
  res.status(204).end();
});

// ============================ Relatório (admin absoluto) ============================

// Etapas do funil de cadastro, em ordem. Cada sessão conta até a etapa MAIS avançada que
// alcançou (quem entrou direto em /cadastrar conta também como "acessou o site"), então os
// números são sempre decrescentes.
const ETAPAS_FUNIL = [
  { chave: 'acessou', label: 'Acessou o site' },
  { chave: 'abriu_cadastro', label: 'Abriu o cadastro' },
  { chave: 'comecou_preencher', label: 'Começou a preencher' },
  { chave: 'clicou_continuar', label: 'Clicou em Continuar' },
  { chave: 'dados_aceitos', label: 'Dados aceitos (etapa 2)' },
  { chave: 'viu_planos', label: 'Chegou nos planos (etapa 3)' },
  { chave: 'enviou_cadastro', label: 'Enviou o cadastro' },
  { chave: 'conta_criada', label: 'Confirmou o e-mail' }
];

function etapaDoEvento(ev) {
  if (ev.tipo === 'pagina') return ev.nome === '/cadastrar' ? 1 : 0;
  if (ev.tipo === 'clique' && ev.nome === 'cadastro_continuar') return 3;
  if (ev.tipo !== 'evento') return 0;
  switch (ev.nome) {
    case 'cadastro_campo': return 2;
    case 'cadastro_campo_invalido': return 3;
    case 'cadastro_continuar': return 3;
    case 'cadastro_etapa': {
      const etapa = Number(ev.dados?.etapa);
      if (etapa >= 3) return 5;
      if (etapa === 2) return 4;
      return 0;
    }
    case 'cadastro_enviado': return ev.dados?.ok ? 6 : 5;
    case 'cadastro_concluido': return 7;
    default: return 0;
  }
}

function intervaloBrasilia(inicio, fim) {
  return { de: `${inicio}T00:00:00-03:00`, ate: `${fim}T23:59:59.999-03:00` };
}

function somarDias(dataIso, dias) {
  const d = new Date(`${dataIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function diasEntre(inicio, fim) {
  return Math.round((new Date(`${fim}T12:00:00Z`) - new Date(`${inicio}T12:00:00Z`)) / 86400000) + 1;
}

// O PostgREST do Supabase devolve no máximo 1000 linhas por chamada; pagina até o teto.
async function buscarTudo(montarQuery, teto = 200000) {
  const tamanho = 1000;
  const linhas = [];
  for (let de = 0; de < teto; de += tamanho) {
    const { data, error } = await montarQuery().range(de, de + tamanho - 1);
    if (error) throw error;
    linhas.push(...(data || []));
    if (!data || data.length < tamanho) break;
  }
  return linhas;
}

async function carregarPeriodo(inicio, fim, filtros) {
  const { de, ate } = intervaloBrasilia(inicio, fim);
  const sessoes = await buscarTudo(() => {
    let q = supabase
      .from('analytics_sessoes')
      .select('id, visitante_id, iniciada_em, canal, origem, utm_campaign, dispositivo, sistema, navegador, pais, estado, cidade')
      .gte('iniciada_em', de)
      .lte('iniciada_em', ate)
      .order('iniciada_em', { ascending: true });
    if (filtros.dispositivo) q = q.eq('dispositivo', filtros.dispositivo);
    if (filtros.canal) q = q.eq('canal', filtros.canal);
    return q;
  });

  // Eventos: janela vai um dia além do fim pra pegar o resto de sessões que começaram perto
  // da meia-noite do último dia.
  const ateEventos = `${somarDias(fim, 1)}T23:59:59.999-03:00`;
  const ids = new Set(sessoes.map((s) => s.id));
  const eventos = ids.size === 0 ? [] : (await buscarTudo(() => supabase
    .from('analytics_eventos')
    .select('sessao_id, tipo, nome, caminho, dados, criado_em')
    .gte('criado_em', de)
    .lte('criado_em', ateEventos)
    .order('criado_em', { ascending: true })
  )).filter((e) => ids.has(e.sessao_id));

  return { sessoes, eventos };
}

function calcularEtapas(sessoes, eventos) {
  const maxEtapa = new Map(sessoes.map((s) => [s.id, 0]));
  for (const ev of eventos) {
    const etapa = etapaDoEvento(ev);
    if (etapa > (maxEtapa.get(ev.sessao_id) ?? 0)) maxEtapa.set(ev.sessao_id, etapa);
  }
  return maxEtapa;
}

function contarFunil(maxEtapa) {
  return ETAPAS_FUNIL.map((etapa, i) => ({
    ...etapa,
    sessoes: Array.from(maxEtapa.values()).filter((m) => m >= i).length
  }));
}

// Agrupa sessões por uma chave e conta: sessões, quantas abriram o cadastro e quantas
// criaram a conta.
function agrupar(sessoes, maxEtapa, chaveDe, limite = 20) {
  const grupos = new Map();
  for (const s of sessoes) {
    const chave = chaveDe(s);
    if (chave == null || chave === '') continue;
    const g = grupos.get(chave) || { chave, sessoes: 0, cadastro: 0, contas: 0 };
    const m = maxEtapa.get(s.id) || 0;
    g.sessoes += 1;
    if (m >= 1) g.cadastro += 1;
    if (m >= 7) g.contas += 1;
    grupos.set(chave, g);
  }
  return Array.from(grupos.values()).sort((a, b) => b.sessoes - a.sessoes).slice(0, limite);
}

function contarEventos(eventos, filtro, chaveDe, limite = 30) {
  const grupos = new Map();
  for (const ev of eventos) {
    if (!filtro(ev)) continue;
    const chave = chaveDe(ev);
    if (!chave) continue;
    const g = grupos.get(chave) || { chave, total: 0, sessoes: new Set() };
    g.total += 1;
    g.sessoes.add(ev.sessao_id);
    grupos.set(chave, g);
  }
  return Array.from(grupos.values())
    .map((g) => ({ chave: g.chave, total: g.total, sessoes: g.sessoes.size }))
    .sort((a, b) => b.sessoes - a.sessoes || b.total - a.total)
    .slice(0, limite);
}

const ROTULO_CAMPO = {
  nome: 'Nome do negócio', slug: 'Endereço (slug)', email: 'E-mail', telefone: 'Telefone',
  documento: 'CPF/CNPJ', senha: 'Senha', codigo: 'Código de confirmação'
};

router.get('/super-admin/analytics/funil', async (req, res) => {
  const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const dataValida = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
  const fim = dataValida(req.query.fim) ? req.query.fim : hoje;
  const inicio = dataValida(req.query.inicio) ? req.query.inicio : somarDias(fim, -29);
  if (inicio > fim) return res.status(400).json({ error: 'A data inicial precisa ser antes da final.' });
  if (diasEntre(inicio, fim) > 366) return res.status(400).json({ error: 'Escolha um período de até 1 ano.' });

  const filtros = {
    dispositivo: ['mobile', 'tablet', 'desktop'].includes(req.query.dispositivo) ? req.query.dispositivo : null,
    canal: ['direto', 'organico', 'pago', 'social', 'referencia', 'email'].includes(req.query.canal) ? req.query.canal : null
  };

  const dias = diasEntre(inicio, fim);
  const fimAnterior = somarDias(inicio, -1);
  const inicioAnterior = somarDias(fimAnterior, -(dias - 1));

  try {
    const [atual, anterior] = await Promise.all([
      carregarPeriodo(inicio, fim, filtros),
      carregarPeriodo(inicioAnterior, fimAnterior, filtros)
    ]);

    const maxEtapa = calcularEtapas(atual.sessoes, atual.eventos);
    const maxEtapaAnterior = calcularEtapas(anterior.sessoes, anterior.eventos);
    const funilAnterior = contarFunil(maxEtapaAnterior);
    const funil = contarFunil(maxEtapa).map((e, i) => ({ ...e, sessoes_anterior: funilAnterior[i].sessoes }));

    // Funil por dispositivo (só as contagens), pra comparar mobile x desktop lado a lado.
    const porDispositivo = ['mobile', 'desktop', 'tablet'].map((disp) => {
      const ids = new Set(atual.sessoes.filter((s) => s.dispositivo === disp).map((s) => s.id));
      const sub = new Map(Array.from(maxEtapa.entries()).filter(([id]) => ids.has(id)));
      return { dispositivo: disp, etapas: contarFunil(sub).map((e) => e.sessoes) };
    }).filter((d) => d.etapas[0] > 0);

    // Entrar (login do admin): quem clicou em algum "Entrar" ou abriu /admin/login, e quantos
    // logaram de fato.
    const sessoesEntrar = new Set();
    const sessoesLogou = new Set();
    for (const ev of atual.eventos) {
      if ((ev.tipo === 'clique' && /entrar/i.test(ev.nome)) || (ev.tipo === 'pagina' && ev.nome === '/admin/login')) sessoesEntrar.add(ev.sessao_id);
      if (ev.tipo === 'evento' && ev.nome === 'login' && ev.dados?.ok) sessoesLogou.add(ev.sessao_id);
    }

    // Abandono do cadastro: pra quem começou a preencher mas não criou a conta, qual foi o
    // último campo tocado, e quais erros de validação apareceram.
    const ultimoCampo = new Map();
    for (const ev of atual.eventos) {
      if (ev.tipo === 'evento' && ev.nome === 'cadastro_campo' && ev.dados?.campo) ultimoCampo.set(ev.sessao_id, ev.dados.campo);
    }
    const abandonoCampos = new Map();
    for (const [sessaoId, campo] of ultimoCampo.entries()) {
      const m = maxEtapa.get(sessaoId) || 0;
      if (m >= 2 && m < 7) abandonoCampos.set(campo, (abandonoCampos.get(campo) || 0) + 1);
    }
    const errosValidacao = contarEventos(
      atual.eventos,
      (ev) => ev.tipo === 'evento' && (ev.nome === 'cadastro_campo_invalido' || (ev.nome === 'cadastro_continuar' && ev.dados?.ok === false)),
      (ev) => ROTULO_CAMPO[ev.dados?.campo] || ev.dados?.campo || 'Outro'
    );
    const errosEnvio = contarEventos(
      atual.eventos,
      (ev) => ev.tipo === 'evento' && ev.nome === 'cadastro_enviado' && ev.dados?.ok === false,
      (ev) => ev.dados?.erro || 'Erro sem mensagem'
    );
    const errosCodigo = atual.eventos.filter((ev) => ev.tipo === 'evento' && ev.nome === 'cadastro_codigo' && ev.dados?.ok === false).length;

    // Série diária (horário de Brasília).
    const diaDe = (iso) => new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 10);
    const serie = new Map();
    for (let d = inicio; d <= fim; d = somarDias(d, 1)) serie.set(d, { dia: d, sessoes: 0, contas: 0 });
    for (const s of atual.sessoes) {
      const linha = serie.get(diaDe(s.iniciada_em));
      if (!linha) continue;
      linha.sessoes += 1;
      if ((maxEtapa.get(s.id) || 0) >= 7) linha.contas += 1;
    }

    const visitantes = new Set(atual.sessoes.map((s) => s.visitante_id)).size;
    const visitantesAnterior = new Set(anterior.sessoes.map((s) => s.visitante_id)).size;
    const semLocalizacao = atual.sessoes.filter((s) => !s.pais).length;

    res.json({
      periodo: { inicio, fim, inicio_anterior: inicioAnterior, fim_anterior: fimAnterior },
      resumo: {
        sessoes: atual.sessoes.length,
        sessoes_anterior: anterior.sessoes.length,
        visitantes,
        visitantes_anterior: visitantesAnterior,
        contas: funil[funil.length - 1].sessoes,
        contas_anterior: funilAnterior[funilAnterior.length - 1].sessoes,
        entrar: sessoesEntrar.size,
        logins: sessoesLogou.size,
        sem_localizacao: semLocalizacao
      },
      funil,
      por_dispositivo: porDispositivo,
      canais: agrupar(atual.sessoes, maxEtapa, (s) => s.canal),
      origens: agrupar(atual.sessoes, maxEtapa, (s) => (s.origem ? `${s.origem}` : null)),
      campanhas: agrupar(atual.sessoes, maxEtapa, (s) => s.utm_campaign),
      paises: agrupar(atual.sessoes, maxEtapa, (s) => s.pais),
      estados: agrupar(atual.sessoes, maxEtapa, (s) => (s.estado ? `${s.estado}${s.pais ? ` (${s.pais})` : ''}` : null)),
      cidades: agrupar(atual.sessoes, maxEtapa, (s) => (s.cidade ? `${s.cidade}${s.estado ? ` - ${s.estado}` : ''}` : null)),
      dispositivos: agrupar(atual.sessoes, maxEtapa, (s) => s.dispositivo),
      navegadores: agrupar(atual.sessoes, maxEtapa, (s) => s.navegador),
      sistemas: agrupar(atual.sessoes, maxEtapa, (s) => s.sistema),
      cliques: contarEventos(atual.eventos, (ev) => ev.tipo === 'clique', (ev) => ev.nome, 40),
      paginas: contarEventos(atual.eventos, (ev) => ev.tipo === 'pagina', (ev) => ev.nome),
      secoes: contarEventos(atual.eventos, (ev) => ev.tipo === 'secao', (ev) => ev.nome),
      abandono: {
        ultimo_campo: Array.from(abandonoCampos.entries())
          .map(([campo, sessoes]) => ({ chave: ROTULO_CAMPO[campo] || campo, sessoes }))
          .sort((a, b) => b.sessoes - a.sessoes),
        erros_validacao: errosValidacao,
        erros_envio: errosEnvio,
        erros_codigo: errosCodigo
      },
      serie: Array.from(serie.values())
    });
  } catch (err) {
    console.error('[analytics] erro no relatório:', err.message);
    res.status(500).json({ error: 'Erro ao montar o relatório do funil.' });
  }
});

module.exports = router;
