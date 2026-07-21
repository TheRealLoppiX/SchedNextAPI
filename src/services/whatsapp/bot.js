const supabase = require('../../config/supabase');
const { enviarMensagem } = require('./provider');
const { limiteAgendamentosMesAtingido } = require('../../utils/limitesPlano');

// Máquina de estados simples do bot de agendamento via WhatsApp (ver §8/§10 do plano de
// plataforma). Reaproveita as mesmas tabelas/regras da agenda web (agendamentos, barbeiros,
// servicos) em vez de manter uma lógica de disponibilidade paralela — o bot é só mais um
// "cliente" dessas regras, igual o plano recomenda.
//
// Fluxo: inicio -> menu -> aguardando_barbeiro -> aguardando_data -> aguardando_horario ->
// aguardando_servico -> [aguardando_nome, se telefone não é de um cliente já cadastrado] -> confirmado

const EXPIRACAO_SESSAO_MIN = 30;

async function obterOuCriarSessao(empresaId, telefone) {
  const { data: existente } = await supabase
    .from('whatsapp_sessoes')
    .select('*')
    .eq('empresa_id', empresaId)
    .eq('telefone', telefone)
    .maybeSingle();

  const expirada = existente && new Date(existente.expira_em) < new Date();

  if (!existente || expirada) {
    const nova = {
      empresa_id: empresaId,
      telefone,
      estado_atual: 'inicio',
      dados_temporarios: {},
      expira_em: new Date(Date.now() + EXPIRACAO_SESSAO_MIN * 60000).toISOString()
    };
    const { data: criada } = await supabase
      .from('whatsapp_sessoes')
      .upsert(nova, { onConflict: 'empresa_id,telefone' })
      .select('*')
      .single();
    return criada;
  }

  return existente;
}

async function salvarSessao(sessao, estado, dadosTemporarios) {
  await supabase
    .from('whatsapp_sessoes')
    .update({
      estado_atual: estado,
      dados_temporarios: dadosTemporarios,
      expira_em: new Date(Date.now() + EXPIRACAO_SESSAO_MIN * 60000).toISOString()
    })
    .eq('id', sessao.id);
}

async function listarBarbeirosAtivos(empresaId) {
  const { data } = await supabase.from('barbeiros').select('id, nome').eq('empresa_id', empresaId).eq('ativo', true);
  return data || [];
}

async function listarServicosAtivos(empresaId) {
  const { data } = await supabase.from('servicos').select('id, nome, duracao, valor').eq('empresa_id', empresaId).eq('ativo', true);
  return data || [];
}

function parseDataFalada(texto) {
  const hoje = new Date();
  const t = texto.trim().toLowerCase();
  if (t === 'hoje') return hoje.toISOString().slice(0, 10);
  if (t === 'amanha' || t === 'amanhã') {
    const amanha = new Date(hoje.getTime() + 24 * 60 * 60 * 1000);
    return amanha.toISOString().slice(0, 10);
  }
  const m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const dia = m[1].padStart(2, '0');
    const mes = m[2].padStart(2, '0');
    const ano = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : String(hoje.getFullYear());
    return `${ano}-${mes}-${dia}`;
  }
  return null;
}

async function horariosDisponiveis(barbeiroId, dataStr) {
  const { data: ocupados } = await supabase
    .from('agendamentos')
    .select('data_hora')
    .eq('barbeiro_id', barbeiroId)
    .gte('data_hora', `${dataStr}T00:00:00`)
    .lte('data_hora', `${dataStr}T23:59:59`)
    .neq('status', 'cancelado');

  const horasOcupadas = new Set((ocupados || []).map((a) => new Date(a.data_hora).toISOString().slice(11, 16)));

  const slots = [];
  for (let h = 8; h < 20; h++) {
    for (const min of [0, 30]) {
      const hStr = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      if (!horasOcupadas.has(hStr)) slots.push(hStr);
    }
  }
  return slots;
}

async function processarMensagem({ empresaId, telefone, texto }) {
  const sessao = await obterOuCriarSessao(empresaId, telefone);
  const dados = sessao.dados_temporarios || {};
  const msg = (texto || '').trim();
  const msgLower = msg.toLowerCase();

  const responder = async (resposta, novoEstado, novosDados) => {
    await enviarMensagem(telefone, resposta);
    await salvarSessao(sessao, novoEstado, novosDados !== undefined ? novosDados : dados);
  };

  if (sessao.estado_atual === 'inicio' || msgLower === 'menu') {
    return responder(
      'Olá! 👋 Digite *AGENDAR* para marcar um horário, ou *SAIR* para encerrar.',
      'menu'
    );
  }

  if (sessao.estado_atual === 'menu') {
    if (msgLower === 'agendar') {
      if (await limiteAgendamentosMesAtingido(empresaId)) {
        return responder('Desculpe, este estabelecimento atingiu o limite de agendamentos do mês. Tente novamente em breve.', 'inicio', {});
      }
      const barbeiros = await listarBarbeirosAtivos(empresaId);
      if (barbeiros.length === 0) return responder('No momento não há profissionais disponíveis para agendamento.', 'inicio', {});
      const lista = barbeiros.map((b, i) => `${i + 1}. ${b.nome}`).join('\n');
      return responder(`Com quem você quer agendar?\n${lista}`, 'aguardando_barbeiro', { barbeiros });
    }
    return responder('Não entendi. Digite *AGENDAR* para marcar um horário.', 'menu');
  }

  if (sessao.estado_atual === 'aguardando_barbeiro') {
    const idx = parseInt(msg, 10) - 1;
    const escolhido = (dados.barbeiros || [])[idx];
    if (!escolhido) return responder('Escolha um número válido da lista.', 'aguardando_barbeiro');
    return responder(
      `Para qual dia? Responda *hoje*, *amanha* ou uma data (dd/mm).`,
      'aguardando_data',
      { ...dados, barbeiro_id: escolhido.id, barbeiro_nome: escolhido.nome }
    );
  }

  if (sessao.estado_atual === 'aguardando_data') {
    const dataEscolhida = parseDataFalada(msg);
    if (!dataEscolhida) return responder('Não entendi a data. Responda *hoje*, *amanha* ou dd/mm.', 'aguardando_data');
    const slots = await horariosDisponiveis(dados.barbeiro_id, dataEscolhida);
    if (slots.length === 0) return responder('Não há horários livres nesse dia. Tente outra data.', 'aguardando_data', dados);
    const lista = slots.map((h, i) => `${i + 1}. ${h}`).join('\n');
    return responder(`Horários livres:\n${lista}`, 'aguardando_horario', { ...dados, data: dataEscolhida, slots });
  }

  if (sessao.estado_atual === 'aguardando_horario') {
    const idx = parseInt(msg, 10) - 1;
    const horaEscolhida = (dados.slots || [])[idx];
    if (!horaEscolhida) return responder('Escolha um número válido da lista de horários.', 'aguardando_horario');
    const servicos = await listarServicosAtivos(empresaId);
    if (servicos.length === 0) return responder('Nenhum serviço cadastrado para agendamento no momento.', 'inicio', {});
    const lista = servicos.map((s, i) => `${i + 1}. ${s.nome} (R$ ${Number(s.valor).toFixed(2)})`).join('\n');
    return responder(`Qual serviço?\n${lista}`, 'aguardando_servico', { ...dados, hora: horaEscolhida, servicos });
  }

  if (sessao.estado_atual === 'aguardando_servico') {
    const idx = parseInt(msg, 10) - 1;
    const servicoEscolhido = (dados.servicos || [])[idx];
    if (!servicoEscolhido) return responder('Escolha um número válido da lista de serviços.', 'aguardando_servico');

    const { data: usuarioExistente } = await supabase
      .from('usuarios')
      .select('id, nome_completo')
      .eq('telefone', telefone)
      .eq('empresa_id', empresaId)
      .maybeSingle();

    const novosDados = { ...dados, servico_id: servicoEscolhido.id, servico_nome: servicoEscolhido.nome, servico_valor: servicoEscolhido.valor, servico_duracao: servicoEscolhido.duracao, usuario_id: usuarioExistente?.id || null };

    if (usuarioExistente) {
      return criarAgendamentoEConfirmar({ empresaId, telefone, sessao, dados: novosDados, nomeCliente: usuarioExistente.nome_completo });
    }

    return responder('Não te encontrei no cadastro. Qual seu nome completo?', 'aguardando_nome', novosDados);
  }

  if (sessao.estado_atual === 'aguardando_nome') {
    if (msg.length < 2) return responder('Digite seu nome completo, por favor.', 'aguardando_nome');
    return criarAgendamentoEConfirmar({ empresaId, telefone, sessao, dados, nomeCliente: msg });
  }

  return responder('Digite *MENU* para ver as opções.', 'inicio', {});
}

async function criarAgendamentoEConfirmar({ empresaId, telefone, sessao, dados, nomeCliente }) {
  const dataHora = `${dados.data}T${dados.hora}:00`;

  const { error } = await supabase.from('agendamentos').insert({
    usuario_id: dados.usuario_id || null,
    empresa_id: empresaId,
    barbeiro_id: dados.barbeiro_id,
    data_hora: dataHora,
    status: 'confirmado',
    valor_total: dados.servico_valor,
    duracao_total: dados.servico_duracao,
    cliente_nome: dados.usuario_id ? null : nomeCliente
  });

  if (error) {
    console.error('Erro ao criar agendamento via WhatsApp:', error);
    await enviarMensagem(telefone, 'Não consegui concluir o agendamento agora. Tente novamente em instantes.');
    await salvarSessao(sessao, 'inicio', {});
    return;
  }

  await enviarMensagem(
    telefone,
    `✅ Agendamento confirmado!\n${dados.barbeiro_nome} — ${dados.servico_nome}\n${dados.data.split('-').reverse().join('/')} às ${dados.hora}\n\nDigite *MENU* para agendar outro horário.`
  );
  await salvarSessao(sessao, 'inicio', {});
}

module.exports = { processarMensagem };
