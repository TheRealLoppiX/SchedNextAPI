const bcrypt = require('bcrypt');
const supabase = require('../../config/supabase');
const { criarPendente, buscarPendenteValido, removerPendente } = require('../cadastroPendente');
const { enviarMensagem, enviarImagem } = require('./provider');
const { criarPagamentoPix } = require('../mercadopago');
const { limiteAgendamentosMesAtingido, obterTaxaMarketplace } = require('../../utils/limitesPlano');
const { paraConvencaoDoBanco } = require('../../utils/horarioBrasilia');
const { gerarTexto, estaConfigurado: iaConfigurada } = require('../groq');
const {
  EMAIL_REGEX,
  obterOuCriarSessao,
  salvarSessao,
  listarBarbeirosAtivos,
  listarServicosAtivos,
  encontrarClientePorTelefone,
  enviarEmailCodigoCadastro,
  gerarCodigoConfirmacao,
  parseDataFalada,
  horariosDisponiveis,
  inserirAgendamento
} = require('./helpers');
const { processar: processarComAgente } = require('./agente');

// Interpreta texto livre (ex: "quero cortar amanhã de tarde") e mapeia pra uma das opções do
// menu. Usado tanto na primeira mensagem de uma conversa nova quanto como uma última tentativa
// antes de desistir com "não entendi" em qualquer estado do meio do fluxo (ver
// tentarInterceptarGlobal) — é o que permite o cliente pedir o que quer a qualquer momento, sem
// precisar digitar MENU antes. Puramente um classificador de intenção (responde só a palavra
// AGENDAR/AGENDAMENTOS/NENHUM); a máquina de estados em si continua tocando o fluxo normalmente
// a partir da opção escolhida.
async function interpretarIntencaoMenu(texto) {
  if (!iaConfigurada()) return null;
  try {
    const resposta = await gerarTexto({
      sistema: 'Você classifica a intenção de uma mensagem de WhatsApp enviada a um bot de agendamento de barbearia/salão. Responda APENAS uma destas palavras, sem mais nada: AGENDAR (a pessoa quer marcar/remarcar um horário), AGENDAMENTOS (a pessoa quer ver ou cancelar um agendamento que já tem), ou NENHUM (não deu pra saber).',
      prompt: texto,
      maxTokens: 6,
      temperatura: 0
    });
    const intencao = resposta.trim().toUpperCase();
    if (intencao.startsWith('AGENDAR')) return 'agendar';
    if (intencao.startsWith('AGENDAMENTO')) return 'agendamentos';
  } catch (err) {
    console.error('Erro ao interpretar intenção via IA no bot do WhatsApp:', err);
  }
  return null;
}

// Resolve a intenção da mensagem pros dois fluxos principais (agendar / ver-agendamentos).
// `atalhosNumericos` só é ligado no estado 'menu'/'inicio' (onde "1"/"2" realmente significam as
// opções do menu) — nos demais estados um "1"/"2" já foi tratado como escolha de item da lista
// atual antes de chegar aqui, então tratar como atalho de menu ali seria ambíguo/errado.
async function resolverIntencaoGlobal(msg, msgLower, { atalhosNumericos = false } = {}) {
  if (atalhosNumericos && (msg === '1' || msgLower === 'agendar')) return 'agendar';
  if (atalhosNumericos && (msg === '2' || msgLower.includes('agendamento'))) return 'agendamentos';
  if (!atalhosNumericos && msgLower === 'agendar') return 'agendar';
  if (!atalhosNumericos && msgLower.includes('agendamento')) return 'agendamentos';
  return interpretarIntencaoMenu(msg);
}

// Busca a configuração de personalidade/modo do bot (ver sql/2026_whatsapp_bot_personalidade.sql
// e o painel em AdminWhatsapp.js). Modo livre/personalidade/nome/temperatura só valem de fato com
// IA liberada no plano (Profissional/Enterprise) — sem isso a empresa sempre roda no guiado com
// textos fixos, mesma regra já usada pra classificação de intenção acima. boas_vindas é a exceção:
// é só troca de texto fixo por outro texto fixo, sem custo de IA, então vale pra qualquer plano.
async function obterConfigBot(empresaId) {
  const { data } = await supabase
    .from('empresas')
    .select('whatsapp_bot_modo, whatsapp_bot_nome, whatsapp_bot_personalidade, whatsapp_bot_boas_vindas, whatsapp_bot_temperatura, plano_plataforma:plano_plataforma_id(permite_ia)')
    .eq('id', empresaId)
    .maybeSingle();

  const permiteIa = !!data?.plano_plataforma?.permite_ia;
  return {
    permiteIa,
    modo: permiteIa ? (data?.whatsapp_bot_modo || 'guiado') : 'guiado',
    nome: permiteIa ? (data?.whatsapp_bot_nome || null) : null,
    personalidade: permiteIa ? (data?.whatsapp_bot_personalidade || null) : null,
    boasVindas: data?.whatsapp_bot_boas_vindas || null,
    temperatura: data?.whatsapp_bot_temperatura != null ? Number(data.whatsapp_bot_temperatura) : 0.6
  };
}

// Reescreve uma mensagem do bot no tom/estilo configurado pela empresa, preservando o
// significado. Nunca aplicada a mensagens com lista numerada (regex abaixo) — ali o número
// precisa continuar batendo exatamente com o índice que a máquina de estados vai interpretar na
// resposta do cliente, e deixar a IA "só ajustar o tom" de uma lista é arriscar ela reescrever,
// reordenar ou remover um item. Falha silenciosa (volta o texto original) se a Groq cair ou não
// estiver configurada — personalidade é tempero, nunca pode ser motivo do bot não responder.
async function comPersonalidade(texto, config) {
  if (!config.personalidade || !iaConfigurada() || /^\s*\d+[.)]\s/m.test(texto)) return texto;
  try {
    const sistema = `Você é${config.nome ? ` ${config.nome},` : ''} assistente virtual de agendamento de um estabelecimento que usa o SchedNext, respondendo por WhatsApp. Personalidade definida pelo dono do negócio: ${config.personalidade}\n\nReescreva a MENSAGEM abaixo mantendo exatamente o mesmo significado e as mesmas informações — nunca invente, remova ou altere dados, valores, datas, horários, nomes ou emojis de status (✅❌). Ajuste só o tom/estilo. Responda só com a mensagem final, sem aspas, sem comentários.`;
    const reescrita = await gerarTexto({ sistema, prompt: texto, maxTokens: 350, temperatura: config.temperatura });
    return reescrita || texto;
  } catch (err) {
    console.error('Erro ao aplicar personalidade do bot (Groq):', err);
    return texto;
  }
}

// As duas construções abaixo (agendar / ver-agendamentos) ficam à parte de processarMensagem
// porque são chamadas de dois lugares: a partir do menu normal, e a partir de
// tentarInterceptarGlobal (quando o cliente pede isso em texto livre no meio de outro estado).
async function construirRespostaAgendar(empresaId) {
  if (await limiteAgendamentosMesAtingido(empresaId)) {
    return { texto: 'Desculpe, este estabelecimento atingiu o limite de agendamentos do mês. Tente novamente em breve.', estado: 'inicio', dados: {} };
  }
  const barbeiros = await listarBarbeirosAtivos(empresaId);
  if (barbeiros.length === 0) {
    return { texto: 'No momento não há profissionais disponíveis para agendamento.', estado: 'inicio', dados: {} };
  }
  const lista = barbeiros.map((b, i) => `${i + 1}. ${b.nome}`).join('\n');
  return { texto: `Com quem você quer agendar?\n${lista}`, estado: 'aguardando_barbeiro', dados: { barbeiros } };
}

async function construirRespostaVerAgendamentos(empresaId, telefone) {
  const cliente = await encontrarClientePorTelefone(empresaId, telefone);
  if (!cliente) {
    return { texto: 'Não encontrei nenhum cadastro com este número de telefone. Digite *MENU* para ver as opções.', estado: 'inicio', dados: {} };
  }

  const { data: futuros } = await supabase
    .from('agendamentos')
    .select('id, data_hora, barbeiros(nome)')
    .eq('usuario_id', cliente.id)
    .eq('empresa_id', empresaId)
    .in('status', ['pendente', 'confirmado'])
    .gte('data_hora', paraConvencaoDoBanco(new Date()).toISOString())
    .order('data_hora', { ascending: true })
    .limit(10);

  if (!futuros || futuros.length === 0) {
    return { texto: 'Você não tem nenhum agendamento futuro. Digite *MENU* para ver as opções.', estado: 'inicio', dados: {} };
  }

  const futurosFmt = futuros.map((a) => {
    const dh = new Date(a.data_hora);
    const dataFmt = `${String(dh.getUTCDate()).padStart(2, '0')}/${String(dh.getUTCMonth() + 1).padStart(2, '0')}`;
    const horaFmt = `${String(dh.getUTCHours()).padStart(2, '0')}:${String(dh.getUTCMinutes()).padStart(2, '0')}`;
    return { dataFmt, horaFmt, nome: a.barbeiros?.nome || 'profissional' };
  });
  const lista = futurosFmt.map((f, i) => `${i + 1}. ${f.dataFmt} às ${f.horaFmt} — ${f.nome}`).join('\n');

  return {
    texto: `Seus próximos agendamentos:\n${lista}\n\nDigite o número de um deles para cancelar, ou *MENU* para voltar.`,
    estado: 'aguardando_escolha_agendamento',
    dados: { agendamentos: futuros }
  };
}

// Tentativa final antes de desistir com "não entendi"/"escolha um número válido" num estado do
// meio do fluxo (ex: aguardando_barbeiro, aguardando_data...) — permite o cliente mudar de ideia
// ou pedir outra coisa a qualquer momento em texto livre, sem precisar digitar SAIR/MENU antes
// pra depois recomeçar. Retorna null se não identificou nada, e quem chamou segue com a mensagem
// de erro específica daquele estado.
async function tentarInterceptarGlobal(msg, msgLower, empresaId, telefone) {
  const intencao = await resolverIntencaoGlobal(msg, msgLower, { atalhosNumericos: false });
  if (intencao === 'agendar') return construirRespostaAgendar(empresaId);
  if (intencao === 'agendamentos') return construirRespostaVerAgendamentos(empresaId, telefone);
  return null;
}

async function processarMensagem({ empresaId, telefone, texto, instancia }) {
  const config = await obterConfigBot(empresaId);

  // Modo livre: a Groq conduz a conversa de ponta a ponta via tool calling (ver agente.js). O
  // guiado abaixo é a máquina de estados de sempre, só com a personalidade/boas-vindas por cima.
  if (config.modo === 'livre' && iaConfigurada()) {
    return processarComAgente({ empresaId, telefone, texto, instancia, config });
  }

  const sessao = await obterOuCriarSessao(empresaId, telefone);
  const dados = sessao.dados_temporarios || {};
  const msg = (texto || '').trim();
  const msgLower = msg.toLowerCase();

  const responder = async (resposta, novoEstado, novosDados) => {
    await enviarMensagem(instancia, telefone, await comPersonalidade(resposta, config));
    await salvarSessao(sessao, novoEstado, novosDados !== undefined ? novosDados : dados);
  };

  // Comandos globais: funcionam em QUALQUER estado, não só no menu. Antes disso, "SAIR" era
  // prometido na mensagem de boas-vindas mas não fazia nada de verdade (caía no catch-all genérico
  // "Digite MENU"), e não havia nenhuma forma de abortar um fluxo de agendamento no meio (ex: o
  // cliente errou o profissional e queria recomeçar sem esperar toda a conversa expirar sozinha).
  if (sessao.estado_atual !== 'inicio' && msgLower === 'sair') {
    return responder('Até logo! 👋 Quando quiser, é só chamar de novo.', 'inicio', {});
  }
  if (sessao.estado_atual !== 'inicio' && sessao.estado_atual !== 'menu' && msgLower === 'cancelar') {
    return responder(
      'Ok, cancelei o que você estava fazendo.\n\nO que deseja fazer?\n1. Agendar um horário\n2. Ver ou cancelar meus agendamentos\n\nDigite o número, ou *SAIR* para encerrar.',
      'menu'
    );
  }

  // A saudação ("Olá! 👋") é customizável por empresa (whatsapp_bot_boas_vindas); o resto do menu
  // continua fixo, já que é uma lista numerada (ver comPersonalidade acima).
  const saudacao = config.boasVindas || 'Olá! 👋';
  const MENSAGEM_MENU = `${saudacao} O que deseja fazer?\n1. Agendar um horário\n2. Ver ou cancelar meus agendamentos\n\nDigite o número, ou *SAIR* para encerrar.`;

  // "menu" digitado explicitamente sempre mostra o menu, em qualquer estado — é um pedido
  // direto, não faz sentido reinterpretar via IA.
  if (msgLower === 'menu') {
    return responder(MENSAGEM_MENU, 'menu');
  }

  if (sessao.estado_atual === 'inicio') {
    // Antes, a primeira mensagem de qualquer conversa nova sempre caía no menu padrão, mesmo se
    // o cliente já tivesse dito o que queria (ex: "quero cortar amanhã de tarde") — precisava
    // digitar de novo depois de ver o menu. Agora tenta entender de cara; só mostra o menu se
    // não identificar nada.
    const intencao = await resolverIntencaoGlobal(msg, msgLower, { atalhosNumericos: true });
    if (intencao === 'agendar') {
      const { texto: t, estado, dados: d } = await construirRespostaAgendar(empresaId);
      return responder(t, estado, d);
    }
    if (intencao === 'agendamentos') {
      const { texto: t, estado, dados: d } = await construirRespostaVerAgendamentos(empresaId, telefone);
      return responder(t, estado, d);
    }
    return responder(MENSAGEM_MENU, 'menu');
  }

  if (sessao.estado_atual === 'menu') {
    const opcaoEscolhida = await resolverIntencaoGlobal(msg, msgLower, { atalhosNumericos: true });

    if (opcaoEscolhida === 'agendar') {
      const { texto: t, estado, dados: d } = await construirRespostaAgendar(empresaId);
      return responder(t, estado, d);
    }

    if (opcaoEscolhida === 'agendamentos') {
      const { texto: t, estado, dados: d } = await construirRespostaVerAgendamentos(empresaId, telefone);
      return responder(t, estado, d);
    }

    return responder('Não entendi. Digite *1* para agendar ou *2* para ver seus agendamentos.', 'menu');
  }

  if (sessao.estado_atual === 'aguardando_escolha_agendamento') {
    const idx = parseInt(msg, 10) - 1;
    const escolhido = (dados.agendamentos || [])[idx];
    if (!escolhido) {
      const global = await tentarInterceptarGlobal(msg, msgLower, empresaId, telefone);
      if (global) return responder(global.texto, global.estado, global.dados);
      return responder('Escolha um número válido da lista, ou digite *MENU* para voltar.', 'aguardando_escolha_agendamento');
    }

    const dh = new Date(escolhido.data_hora);
    const dataFmt = `${String(dh.getUTCDate()).padStart(2, '0')}/${String(dh.getUTCMonth() + 1).padStart(2, '0')} às ${String(dh.getUTCHours()).padStart(2, '0')}:${String(dh.getUTCMinutes()).padStart(2, '0')}`;
    return responder(
      `Confirma cancelar o agendamento de ${dataFmt} com ${escolhido.barbeiros?.nome || 'profissional'}?\nResponda *SIM* ou *NAO*.`,
      'confirmando_cancelamento',
      { ...dados, agendamento_cancelar_id: escolhido.id, agendamento_cancelar_texto: dataFmt }
    );
  }

  if (sessao.estado_atual === 'confirmando_cancelamento') {
    if (msgLower !== 'sim') {
      return responder('Ok, mantive seu agendamento. Digite *MENU* para ver as opções.', 'inicio', {});
    }
    const { error: erroCancelar } = await supabase
      .from('agendamentos')
      .update({ status: 'cancelado', justificativa_cancelamento: 'Cancelado pelo cliente via WhatsApp', cancelado_por: 'cliente' })
      .eq('id', dados.agendamento_cancelar_id)
      .eq('empresa_id', empresaId);

    if (erroCancelar) {
      console.error('Erro ao cancelar agendamento via WhatsApp:', erroCancelar);
      return responder('Não consegui cancelar agora. Tente novamente em instantes.', 'inicio', {});
    }
    return responder(`✅ Agendamento de ${dados.agendamento_cancelar_texto} cancelado. Digite *MENU* para ver as opções.`, 'inicio', {});
  }

  if (sessao.estado_atual === 'aguardando_barbeiro') {
    const idx = parseInt(msg, 10) - 1;
    const escolhido = (dados.barbeiros || [])[idx];
    if (!escolhido) {
      const global = await tentarInterceptarGlobal(msg, msgLower, empresaId, telefone);
      if (global) return responder(global.texto, global.estado, global.dados);
      return responder('Escolha um número válido da lista.', 'aguardando_barbeiro');
    }
    return responder(
      `Para qual dia? Responda *hoje*, *amanha* ou uma data (dd/mm).`,
      'aguardando_data',
      { ...dados, barbeiro_id: escolhido.id, barbeiro_nome: escolhido.nome }
    );
  }

  if (sessao.estado_atual === 'aguardando_data') {
    const dataEscolhida = parseDataFalada(msg);
    if (!dataEscolhida) {
      const global = await tentarInterceptarGlobal(msg, msgLower, empresaId, telefone);
      if (global) return responder(global.texto, global.estado, global.dados);
      return responder('Não entendi a data. Responda *hoje*, *amanha* ou dd/mm.', 'aguardando_data');
    }
    const slots = await horariosDisponiveis(empresaId, dados.barbeiro_id, dataEscolhida);
    if (slots.length === 0) return responder('Não há horários livres nesse dia. Tente outra data.', 'aguardando_data', dados);
    const lista = slots.map((h, i) => `${i + 1}. ${h}`).join('\n');
    return responder(`Horários livres:\n${lista}`, 'aguardando_horario', { ...dados, data: dataEscolhida, slots });
  }

  if (sessao.estado_atual === 'aguardando_horario') {
    const idx = parseInt(msg, 10) - 1;
    const horaEscolhida = (dados.slots || [])[idx];
    if (!horaEscolhida) {
      const global = await tentarInterceptarGlobal(msg, msgLower, empresaId, telefone);
      if (global) return responder(global.texto, global.estado, global.dados);
      return responder('Escolha um número válido da lista de horários.', 'aguardando_horario');
    }
    const servicos = await listarServicosAtivos(empresaId);
    if (servicos.length === 0) return responder('Nenhum serviço cadastrado para agendamento no momento.', 'inicio', {});
    const lista = servicos.map((s, i) => `${i + 1}. ${s.nome} (R$ ${Number(s.valor).toFixed(2)})`).join('\n');
    return responder(`Qual serviço?\n${lista}`, 'aguardando_servico', { ...dados, hora: horaEscolhida, servicos });
  }

  if (sessao.estado_atual === 'aguardando_servico') {
    const idx = parseInt(msg, 10) - 1;
    const servicoEscolhido = (dados.servicos || [])[idx];
    if (!servicoEscolhido) {
      const global = await tentarInterceptarGlobal(msg, msgLower, empresaId, telefone);
      if (global) return responder(global.texto, global.estado, global.dados);
      return responder('Escolha um número válido da lista de serviços.', 'aguardando_servico');
    }

    const usuarioExistente = await encontrarClientePorTelefone(empresaId, telefone);

    const novosDados = { ...dados, servico_id: servicoEscolhido.id, servico_nome: servicoEscolhido.nome, servico_valor: servicoEscolhido.valor, servico_duracao: servicoEscolhido.duracao, usuario_id: usuarioExistente?.id || null };

    if (usuarioExistente) {
      return criarAgendamentoEConfirmar({ empresaId, telefone, instancia, sessao, dados: novosDados, nomeCliente: usuarioExistente.nome_completo, config });
    }

    return responder('Não te encontrei no cadastro. Qual seu nome completo?', 'aguardando_nome', novosDados);
  }

  if (sessao.estado_atual === 'aguardando_nome') {
    if (msg.length < 2) return responder('Digite seu nome completo, por favor.', 'aguardando_nome');
    return responder(
      `Prazer, ${msg}! Agora preciso do seu e-mail pra confirmar o cadastro.`,
      'aguardando_email',
      { ...dados, nome_cadastro: msg }
    );
  }

  if (sessao.estado_atual === 'aguardando_email') {
    const emailNormalizado = msg.toLowerCase();
    if (!EMAIL_REGEX.test(emailNormalizado)) {
      return responder('Esse e-mail não parece válido. Digite seu e-mail:', 'aguardando_email');
    }

    const { data: emailJaExiste } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', emailNormalizado)
      .eq('empresa_id', empresaId)
      .maybeSingle();

    if (emailJaExiste) {
      return responder('Esse e-mail já tem cadastro por aqui. Digite outro e-mail, ou *SAIR* para cancelar.', 'aguardando_email');
    }

    return responder(
      'Show! Agora escolha uma senha (mínimo 6 caracteres) — pode usar depois pra entrar no site como cliente.',
      'aguardando_senha',
      { ...dados, email_cadastro: emailNormalizado }
    );
  }

  if (sessao.estado_atual === 'aguardando_senha') {
    if (msg.length < 6) {
      return responder('A senha precisa ter pelo menos 6 caracteres. Digite uma senha:', 'aguardando_senha');
    }

    const senhaHash = await bcrypt.hash(msg, 12);
    const codigo = gerarCodigoConfirmacao();

    const { error: erroPendente } = await criarPendente({
      tipo: 'cliente',
      email: dados.email_cadastro,
      empresa_id: empresaId,
      codigo,
      dados: { nome: dados.nome_cadastro, nascimento: null, telefone, senha: senhaHash, empresa_id: empresaId }
    });

    if (erroPendente) {
      console.error('Erro ao criar cadastro pendente via bot do WhatsApp:', erroPendente);
      return responder('Não consegui gerar o código de confirmação agora. Tente novamente em instantes.', 'aguardando_senha', dados);
    }

    enviarEmailCodigoCadastro(dados.email_cadastro, dados.nome_cadastro, codigo);

    return responder(
      `Mandamos um código de confirmação para ${dados.email_cadastro}. Digite o código aqui para concluir o cadastro (ou *REENVIAR* para receber um novo).`,
      'aguardando_codigo_cadastro',
      dados
    );
  }

  if (sessao.estado_atual === 'aguardando_codigo_cadastro') {
    if (msgLower === 'reenviar') {
      // Busca o pendente já existente (criado em 'aguardando_senha') só pra reaproveitar o mesmo
      // hash de senha — criarPendente faz upsert por (tipo,email,empresa_id), então só troca o
      // código e a validade, sem pedir a senha de novo.
      const { data: pendenteAtual } = await supabase
        .from('cadastros_pendentes')
        .select('dados')
        .eq('tipo', 'cliente')
        .eq('email', dados.email_cadastro)
        .eq('empresa_id', empresaId)
        .maybeSingle();

      if (!pendenteAtual) {
        return responder('Seu cadastro pendente expirou. Digite *MENU* para recomeçar.', 'inicio', {});
      }

      const codigo = gerarCodigoConfirmacao();
      const { error: erroPendente } = await criarPendente({
        tipo: 'cliente',
        email: dados.email_cadastro,
        empresa_id: empresaId,
        codigo,
        dados: pendenteAtual.dados
      });
      if (!erroPendente) enviarEmailCodigoCadastro(dados.email_cadastro, dados.nome_cadastro, codigo);
      return responder('Novo código enviado! Digite ele aqui para concluir o cadastro.', 'aguardando_codigo_cadastro', dados);
    }

    const pendente = await buscarPendenteValido({ tipo: 'cliente', email: dados.email_cadastro, codigo: msg });
    if (!pendente) {
      return responder('Código inválido ou expirado. Confira o e-mail e digite de novo, ou *REENVIAR* para receber um novo código.', 'aguardando_codigo_cadastro');
    }

    const { nome, nascimento, telefone: telefonePendente, senha, empresa_id } = pendente.dados;
    const { data: novoUsuario, error: erroCadastro } = await supabase
      .from('usuarios')
      .insert({
        nome_completo: nome,
        data_nascimento: nascimento,
        email: dados.email_cadastro,
        telefone: telefonePendente,
        senha,
        empresa_id,
        ativo: true,
        tipo: 'cliente'
      })
      .select('id')
      .single();

    if (erroCadastro) {
      console.error('Erro ao ativar cadastro via bot do WhatsApp:', erroCadastro);
      return responder('Não consegui concluir seu cadastro agora. Tente novamente em instantes, ou digite *MENU*.', 'inicio', {});
    }

    await removerPendente(pendente.id);
    return criarAgendamentoEConfirmar({ empresaId, telefone, instancia, sessao, dados: { ...dados, usuario_id: novoUsuario.id }, nomeCliente: nome, config });
  }

  // Pergunta feita logo após confirmar o agendamento, só quando a empresa tem Mercado Pago
  // conectado (ver criarAgendamentoEConfirmar) — pagamento antecipado é opcional, então "não"
  // (ou qualquer coisa que não seja "sim") só encerra normalmente, sem travar o fluxo.
  if (sessao.estado_atual === 'aguardando_pix') {
    if (msgLower !== 'sim') {
      return responder('Sem problema, é só pagar direto no local. Digite *MENU* para agendar outro horário.', 'inicio', {});
    }
    return gerarPixEEnviar({ empresaId, telefone, instancia, sessao, dados });
  }

  return responder('Digite *MENU* para ver as opções.', 'inicio', {});
}

// Gera a mesma cobrança Pix usada no PDV (ver POST /admin/mercadopago/pix/:agendamentoId), só que
// disparada pelo próprio bot em vez de um clique do admin. A confirmação do pagamento continua
// 100% pelo webhook do Mercado Pago já existente (routes/mercadopago.js -> reconfirmarPagamento ->
// notificarPagamentoConfirmado) — daqui só sai o convite pra pagar, o aviso de "pago" chega depois
// por conta própria, de forma assíncrona.
async function gerarPixEEnviar({ empresaId, telefone, instancia, sessao, dados }) {
  const finalizar = () => salvarSessao(sessao, 'inicio', {});

  const { data: empresa } = await supabase.from('empresas').select('nome, mercadopago_access_token').eq('id', empresaId).maybeSingle();
  if (!empresa?.mercadopago_access_token) {
    await enviarMensagem(instancia, telefone, 'Não consegui gerar o Pix agora. Digite *MENU* para agendar outro horário.');
    return finalizar();
  }

  try {
    const valor = Number(dados.valor_pix);
    const taxaPercentual = await obterTaxaMarketplace(empresaId);
    const cobranca = await criarPagamentoPix({
      accessTokenVendedor: empresa.mercadopago_access_token,
      valor,
      descricao: `SchedNext — atendimento em ${empresa.nome}`,
      externalReference: dados.agendamento_id,
      applicationFee: valor * (taxaPercentual / 100)
    });

    await supabase
      .from('agendamentos')
      .update({ mercadopago_payment_id: String(cobranca.id), pagamento_status: 'pendente' })
      .eq('id', dados.agendamento_id)
      .eq('empresa_id', empresaId);

    const qrBase64 = cobranca.point_of_interaction?.transaction_data?.qr_code_base64;
    const qrCode = cobranca.point_of_interaction?.transaction_data?.qr_code;
    if (!qrCode) throw new Error('Mercado Pago não devolveu o código Pix.');

    if (qrBase64) await enviarImagem(instancia, telefone, qrBase64, `Pix de R$ ${valor.toFixed(2)}`);
    await enviarMensagem(instancia, telefone, `Código Pix Copia e Cola:\n${qrCode}\n\nAssim que o pagamento cair, te aviso por aqui. ✅`);
  } catch (err) {
    console.error('Erro ao gerar Pix via bot do WhatsApp:', err);
    await enviarMensagem(instancia, telefone, 'Não consegui gerar o Pix agora. Pode pagar direto no local.');
  }

  return finalizar();
}

async function criarAgendamentoEConfirmar({ empresaId, telefone, instancia, sessao, dados, nomeCliente, config }) {
  const dataHora = `${dados.data}T${dados.hora}:00`;

  const resultado = await inserirAgendamento({
    empresaId,
    usuarioId: dados.usuario_id,
    barbeiroId: dados.barbeiro_id,
    dataHora,
    servicoValor: dados.servico_valor,
    servicoDuracao: dados.servico_duracao,
    clienteNome: nomeCliente
  });

  if (resultado.conflito) {
    await enviarMensagem(instancia, telefone, await comPersonalidade('Esse horário acabou de ser reservado por outra pessoa. Digite *MENU* para tentar outro horário.', config));
    await salvarSessao(sessao, 'inicio', {});
    return;
  }

  if (!resultado.ok) {
    console.error('Erro ao criar agendamento via WhatsApp:', resultado.erro);
    await enviarMensagem(instancia, telefone, await comPersonalidade('Não consegui concluir o agendamento agora. Tente novamente em instantes.', config));
    await salvarSessao(sessao, 'inicio', {});
    return;
  }

  const confirmacao = `✅ Agendamento confirmado!\n${dados.barbeiro_nome}, ${dados.servico_nome}\n${dados.data.split('-').reverse().join('/')} às ${dados.hora}`;

  // Oferece adiantar o pagamento via Pix só quando a empresa tem Mercado Pago conectado (ver
  // routes/mercadopago.js) — sem conta conectada não tem pra onde gerar a cobrança.
  const { data: empresaPix } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', empresaId).maybeSingle();
  if (empresaPix?.mercadopago_access_token) {
    await enviarMensagem(instancia, telefone, await comPersonalidade(`${confirmacao}\n\nQuer adiantar o pagamento agora via Pix? Responda *SIM* ou *NAO*.`, config));
    await salvarSessao(sessao, 'aguardando_pix', { agendamento_id: resultado.id, valor_pix: dados.servico_valor });
    return;
  }

  await enviarMensagem(instancia, telefone, await comPersonalidade(`${confirmacao}\n\nDigite *MENU* para agendar outro horário.`, config));
  await salvarSessao(sessao, 'inicio', {});
}

module.exports = { processarMensagem };
