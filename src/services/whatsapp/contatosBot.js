const supabase = require('../../config/supabase');
const { listarContatos } = require('./provider');
const { variantesTelefoneBR } = require('../../utils/telefone');

// Seleção de contatos do bot (ver sql/2026_whatsapp_bot_contatos.sql e o card "Contatos atendidos
// pelo bot" em AdminWhatsapp.js). A lista de contatos vem da Evolution (findContacts) e a seleção
// fica no nosso banco, identificada pelo jid do contato.
//
// O WhatsApp identifica um contato de dois jeitos: pelo número ("5511...@s.whatsapp.net") ou, em
// contas novas/por privacidade, por um código LID ("123...@lid") sem número nenhum. A mesma pessoa
// pode chegar no webhook por um ou pelo outro (com o outro em remoteJidAlt/senderPn), então a
// comparação sempre olha todos os identificadores conhecidos do remetente.

const MODOS = ['todos', 'somente_marcados', 'todos_exceto'];
const POR_PAGINA = 50;
const JID_VALIDO = /^\d{5,20}@(s\.whatsapp\.net|lid)$/;
const CACHE_MS = 5 * 60 * 1000;
const LOTE = 500;

const telefoneDoJid = (jid) => (String(jid || '').endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null);

// Variantes com DDI (com e sem o 9º dígito), mesmo problema de formato tratado em utils/telefone.js.
function variantesComDdi(telefone) {
  if (!telefone) return [];
  return [...new Set(variantesTelefoneBR(telefone).map((v) => `55${v}`).concat(String(telefone).replace(/\D/g, '')))];
}

// Identificadores do remetente de uma mensagem recebida (key do evento messages.upsert).
// `telefone` é o que o bot usa pra sessão, cadastro e resposta: o número real sempre que der pra
// saber; senão, o próprio jid @lid (o envio aceita jid, ver enviarMensagem em provider.js).
function identificarRemetente(key) {
  const brutos = [key?.remoteJid, key?.remoteJidAlt, key?.senderPn].filter(Boolean).map(String);
  const jids = brutos.map((j) => (j.includes('@') ? j : `${j.replace(/\D/g, '')}@s.whatsapp.net`)).filter((j) => JID_VALIDO.test(j));
  const numero = jids.map(telefoneDoJid).find(Boolean) || null;
  return {
    telefone: numero || jids[0] || null,
    jids: [...new Set(jids)],
    telefones: variantesComDdi(numero)
  };
}

// O bot deve responder esse remetente? Erro de consulta: no modo "só os marcados" fica quieto (o
// dono escolheu uma lista fechada, provavelmente num número pessoal); no "todos, exceto" responde,
// mesmo princípio de nunca derrubar o atendimento por causa de um filtro que falhou.
async function deveResponder(empresa, remetente) {
  const modo = empresa.whatsapp_bot_contatos_modo || 'todos';
  if (modo === 'todos') return true;

  const consultas = [];
  if (remetente.jids.length) consultas.push(supabase.from('whatsapp_bot_contatos').select('id').eq('empresa_id', empresa.id).in('jid', remetente.jids).limit(1));
  if (remetente.telefones.length) consultas.push(supabase.from('whatsapp_bot_contatos').select('id').eq('empresa_id', empresa.id).in('telefone', remetente.telefones).limit(1));
  const resultados = await Promise.all(consultas);

  if (resultados.some((r) => r.error)) {
    console.error('Erro ao consultar contatos do bot:', resultados.find((r) => r.error).error);
    return modo === 'todos_exceto';
  }
  const marcado = resultados.some((r) => r.data?.length > 0);
  return modo === 'somente_marcados' ? marcado : !marcado;
}

// ---------------------------------------------------------------- listagem pro painel

// Cache por instância: a Evolution chega a devolver 12 mil contatos, e a tela pagina/busca em
// cima da mesma lista várias vezes seguidas.
const cache = new Map();
async function contatosDaEvolution(instancia, { atualizar = false } = {}) {
  const guardado = cache.get(instancia);
  if (!atualizar && guardado && Date.now() - guardado.em < CACHE_MS) return guardado.lista;

  const brutos = await listarContatos(instancia);
  const vistos = new Map();
  for (const c of brutos) {
    const jid = String(c.remoteJid || '');
    if (!JID_VALIDO.test(jid) || vistos.has(jid)) continue; // grupos, status@broadcast, lixo
    vistos.set(jid, { jid, nome: (c.pushName || '').trim() || null, telefone: telefoneDoJid(jid), foto: c.profilePicUrl || null });
  }
  const lista = [...vistos.values()];
  cache.set(instancia, { lista, em: Date.now() });
  return lista;
}

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function marcadosDaEmpresa(empresaId) {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase.from('whatsapp_bot_contatos').select('jid, telefone, nome').eq('empresa_id', empresaId).range(de, de + 999);
    if (error) throw error;
    linhas.push(...data);
    if (data.length < 1000) return linhas;
  }
}

// Junta a lista da Evolution com os marcados do banco (um contato marcado pode não vir mais da
// Evolution, ex: número adicionado à mão ou chip trocado) e aplica busca/filtro.
async function filtrarContatos({ empresaId, instancia, busca = '', filtro = 'todos', atualizar = false }) {
  let evolution = [];
  let evolutionIndisponivel = false;
  if (instancia) {
    try {
      evolution = await contatosDaEvolution(instancia, { atualizar });
    } catch (err) {
      console.error(`Erro ao listar contatos na Evolution: ${err.message}`);
      evolutionIndisponivel = true;
    }
  } else {
    evolutionIndisponivel = true;
  }

  const marcados = await marcadosDaEmpresa(empresaId);
  const marcadosPorJid = new Map(marcados.map((m) => [m.jid, m]));
  const telefonesMarcados = new Set(marcados.flatMap((m) => variantesComDdi(m.telefone)));

  const todos = new Map(evolution.map((c) => [c.jid, { ...c, marcado: marcadosPorJid.has(c.jid) || (!!c.telefone && telefonesMarcados.has(c.telefone)) }]));
  for (const m of marcados) {
    if (!todos.has(m.jid)) todos.set(m.jid, { jid: m.jid, nome: m.nome, telefone: m.telefone, foto: null, marcado: true });
  }

  const termo = semAcento(busca.trim());
  const digitos = busca.replace(/\D/g, '');
  let lista = [...todos.values()];
  if (filtro === 'com_nome') lista = lista.filter((c) => c.nome);
  if (filtro === 'com_numero') lista = lista.filter((c) => c.telefone);
  if (filtro === 'marcados') lista = lista.filter((c) => c.marcado);
  if (termo) lista = lista.filter((c) => semAcento(c.nome).includes(termo) || (digitos.length >= 3 && (c.telefone || '').includes(digitos)));

  // Com nome primeiro (é por onde o dono reconhece a pessoa), depois por ordem alfabética.
  lista.sort((a, b) => (!a.nome - !b.nome) || semAcento(a.nome).localeCompare(semAcento(b.nome)) || String(a.telefone || a.jid).localeCompare(String(b.telefone || b.jid)));

  return { lista, totalGeral: todos.size, totalMarcados: marcados.length, evolutionIndisponivel };
}

async function listar({ empresaId, instancia, busca, filtro, pagina = 1, atualizar }) {
  const { lista, totalGeral, totalMarcados, evolutionIndisponivel } = await filtrarContatos({ empresaId, instancia, busca, filtro, atualizar });
  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
  const atual = Math.min(Math.max(1, pagina), paginas);
  return {
    contatos: lista.slice((atual - 1) * POR_PAGINA, atual * POR_PAGINA),
    totalFiltro: lista.length,
    totalGeral,
    totalMarcados,
    pagina: atual,
    paginas,
    evolutionIndisponivel
  };
}

// ---------------------------------------------------------------- alterações

async function marcar(empresaId, contatos, marcado) {
  const validos = contatos.filter((c) => JID_VALIDO.test(c.jid));
  if (marcado) {
    for (let i = 0; i < validos.length; i += LOTE) {
      const linhas = validos.slice(i, i + LOTE).map((c) => ({
        empresa_id: empresaId,
        jid: c.jid,
        telefone: telefoneDoJid(c.jid) || (c.telefone ? String(c.telefone).replace(/\D/g, '') : null),
        nome: c.nome ? String(c.nome).slice(0, 120) : null
      }));
      const { error } = await supabase.from('whatsapp_bot_contatos').upsert(linhas, { onConflict: 'empresa_id,jid', ignoreDuplicates: true });
      if (error) throw error;
    }
  } else {
    for (let i = 0; i < validos.length; i += LOTE) {
      const lote = validos.slice(i, i + LOTE);
      const jids = lote.map((c) => c.jid);
      const { error } = await supabase.from('whatsapp_bot_contatos').delete().eq('empresa_id', empresaId).in('jid', jids);
      if (error) throw error;
      // Mesmo número marcado por outro jid (ex: adicionado à mão com/sem o 9º dígito).
      const telefones = lote.flatMap((c) => variantesComDdi(telefoneDoJid(c.jid)));
      if (telefones.length) {
        const { error: e2 } = await supabase.from('whatsapp_bot_contatos').delete().eq('empresa_id', empresaId).in('telefone', telefones);
        if (e2) throw e2;
      }
    }
  }
  return validos.length;
}

async function marcarFiltro({ empresaId, instancia, busca, filtro, marcado }) {
  const { lista } = await filtrarContatos({ empresaId, instancia, busca, filtro });
  return marcar(empresaId, lista, marcado);
}

// Número digitado à mão (contato que não apareceu na lista, ex: nunca conversou com o número).
async function adicionarManual(empresaId, telefone) {
  const base = variantesTelefoneBR(telefone)[0];
  if (!base || (base.length !== 10 && base.length !== 11)) return null;
  const numero = `55${base}`;
  await marcar(empresaId, [{ jid: `${numero}@s.whatsapp.net` }], true);
  return numero;
}

async function definirModo(empresaId, modo) {
  const { error } = await supabase.from('empresas').update({ whatsapp_bot_contatos_modo: modo }).eq('id', empresaId);
  if (error) throw error;
}

module.exports = { MODOS, identificarRemetente, deveResponder, listar, marcar, marcarFiltro, adicionarManual, definirModo };
