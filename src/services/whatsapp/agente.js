// Modo "livre" do bot de WhatsApp: em vez da máquina de estados de textos fixos (bot.js), a
// Groq conduz a conversa de ponta a ponta via tool calling — decide o que perguntar, quando
// checar disponibilidade, quando cadastrar e quando criar o agendamento de fato. Escolhido por
// empresa em whatsapp_bot_modo (ver sql/2026_whatsapp_bot_personalidade.sql e AdminWhatsapp.js),
// só disponível com IA liberada no plano.
//
// Princípio central: a IA nunca decide dado nenhum sozinha — toda informação de negócio
// (profissionais, serviços, horários livres, se o cliente existe, se um horário ainda está
// livre) só chega até ela através das ferramentas abaixo, que fazem a mesma validação que o
// modo guiado faz. A IA só escolhe QUANDO chamar cada ferramenta e como conversar sobre isso.
const bcrypt = require('bcrypt');
const supabase = require('../../config/supabase');
const { enviarMensagem, enviarImagem } = require('./provider');
const { criarPagamentoPix } = require('../mercadopago');
const { criarPendente, buscarPendenteValido, removerPendente } = require('../cadastroPendente');
const { obterTaxaMarketplace, limiteAgendamentosMesAtingido } = require('../../utils/limitesPlano');
const { paraConvencaoDoBanco } = require('../../utils/horarioBrasilia');
const { chat } = require('../groq');
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

const MAX_RODADAS_FERRAMENTA = 4; // tetos de chamadas de ferramenta por mensagem recebida — evita loop indefinido se o modelo insistir em chamar ferramentas sem nunca responder
const MAX_HISTORICO = 8; // mensagens (user+assistant) guardadas entre uma mensagem e outra

// Descrições enxutas de propósito: esse array inteiro é reenviado à Groq em TODA rodada de TODA
// mensagem — é o maior custo fixo de tokens do modo livre (ver comentário em groq.js sobre
// reasoning_effort). listar_barbeiros e listar_servicos viraram um "listar_opcoes" só porque na
// prática são sempre pedidos juntos no início de um agendamento; separados, custavam uma rodada
// inteira (prompt+ferramentas completos reenviados) a mais por atendimento à toa.
function definirFerramentas() {
  return [
    {
      type: 'function',
      function: {
        name: 'listar_opcoes',
        description: 'Lista profissionais e serviços ativos, com ids, preços e duração.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listar_horarios',
        description: 'Horários livres de um profissional numa data. Chame antes de confirmar um horário.',
        parameters: {
          type: 'object',
          properties: {
            barbeiro_id: { type: 'integer' },
            data: { type: 'string', description: '"hoje", "amanha" ou "dd/mm"' }
          },
          required: ['barbeiro_id', 'data']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'verificar_cliente',
        description: 'Verifica se o telefone atual já tem cadastro.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'iniciar_cadastro',
        description: 'Cadastra cliente novo e envia código de confirmação por e-mail. Use se verificar_cliente disser que não tem cadastro.',
        parameters: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            email: { type: 'string' },
            senha: { type: 'string', description: 'mínimo 6 caracteres' }
          },
          required: ['nome', 'email', 'senha']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'confirmar_codigo_cadastro',
        description: 'Confirma o código de 6 dígitos recebido por e-mail e conclui o cadastro.',
        parameters: {
          type: 'object',
          properties: { email: { type: 'string' }, codigo: { type: 'string' } },
          required: ['email', 'codigo']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'criar_agendamento',
        description: 'Cria o agendamento. Só depois de confirmar tudo com listar_horarios e o cliente ter cadastro.',
        parameters: {
          type: 'object',
          properties: {
            barbeiro_id: { type: 'integer' },
            servico_id: { type: 'integer' },
            data: { type: 'string', description: 'mesma data de listar_horarios' },
            hora: { type: 'string', description: 'HH:MM, de listar_horarios' }
          },
          required: ['barbeiro_id', 'servico_id', 'data', 'hora']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'listar_meus_agendamentos',
        description: 'Agendamentos futuros do cliente atual.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cancelar_agendamento',
        description: 'Cancela um agendamento futuro do cliente atual.',
        parameters: {
          type: 'object',
          properties: { agendamento_id: { type: 'integer' } },
          required: ['agendamento_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'gerar_pix',
        description: 'Gera Pix de um agendamento e já manda o QR Code e o código pro cliente — nunca repita o código na sua resposta.',
        parameters: {
          type: 'object',
          properties: { agendamento_id: { type: 'integer' } },
          required: ['agendamento_id']
        }
      }
    }
  ];
}

// Enxuto de propósito: reenviado por inteiro em toda rodada de toda mensagem (ver comentário
// em definirFerramentas sobre o custo fixo de tokens do modo livre).
function montarSistema(config, primeiraMensagem) {
  const partes = [
    `Você é${config.nome ? ` ${config.nome},` : ''} assistente de agendamento (barbearia/salão) via WhatsApp, sistema SchedNext.`
  ];
  if (config.personalidade) partes.push(`Tom (siga à risca): ${config.personalidade}`);
  partes.push(
    'Nunca invente profissional, serviço, preço, horário ou cadastro — sempre confira com as ferramentas. Nunca confirme ' +
    'agendamento sem chamar criar_agendamento com sucesso. Sem cadastro (verificar_cliente), colete nome/e-mail/senha, chame ' +
    'iniciar_cadastro, depois confirmar_codigo_cadastro antes de agendar. Se pix_disponivel vier true após agendar, ofereça Pix ' +
    '(gerar_pix já envia o código, não repita em texto). Seja breve, natural, em português do Brasil.'
  );
  if (primeiraMensagem) {
    partes.push(
      config.boasVindas
        ? `Primeira mensagem — abra no espírito de "${config.boasVindas}", no seu tom.`
        : 'Primeira mensagem — cumprimente antes de ajudar.'
    );
  }
  return partes.join('\n\n');
}

function parseArgsSeguro(argsStr) {
  try {
    return JSON.parse(argsStr || '{}');
  } catch {
    return {};
  }
}

async function executarFerramenta(nome, args, ctx) {
  try {
    switch (nome) {
      case 'listar_opcoes': {
        const [barbeiros, servicos] = await Promise.all([
          listarBarbeirosAtivos(ctx.empresaId),
          listarServicosAtivos(ctx.empresaId)
        ]);
        if (barbeiros.length === 0) return { erro: 'Nenhum profissional disponível no momento.' };
        if (servicos.length === 0) return { erro: 'Nenhum serviço cadastrado no momento.' };
        return {
          barbeiros: barbeiros.map((b) => ({ id: b.id, nome: b.nome })),
          servicos: servicos.map((s) => ({ id: s.id, nome: s.nome, valor: Number(s.valor), duracao_minutos: s.duracao }))
        };
      }

      case 'listar_horarios': {
        const dataISO = parseDataFalada(String(args.data || ''));
        if (!dataISO) return { erro: 'Não entendi a data. Peça pro cliente informar como "hoje", "amanha" ou dd/mm.' };
        const slots = await horariosDisponiveis(ctx.empresaId, args.barbeiro_id, dataISO);
        if (slots.length === 0) return { erro: 'Nenhum horário livre nessa data para esse profissional. Sugira outra data.', data: dataISO };
        return { data: dataISO, horarios_livres: slots };
      }

      case 'verificar_cliente': {
        const cliente = await encontrarClientePorTelefone(ctx.empresaId, ctx.telefone);
        return cliente ? { cadastrado: true, nome: cliente.nome_completo } : { cadastrado: false };
      }

      case 'iniciar_cadastro': {
        const email = String(args.email || '').toLowerCase().trim();
        if (!EMAIL_REGEX.test(email)) return { erro: 'E-mail inválido, peça outro.' };
        if (String(args.senha || '').length < 6) return { erro: 'Senha muito curta, precisa de pelo menos 6 caracteres.' };
        if (!args.nome || String(args.nome).trim().length < 2) return { erro: 'Nome inválido, peça o nome completo.' };

        const { data: emailJaExiste } = await supabase
          .from('usuarios').select('id').eq('email', email).eq('empresa_id', ctx.empresaId).maybeSingle();
        if (emailJaExiste) return { erro: 'Esse e-mail já tem cadastro nesta empresa. Peça outro e-mail.' };

        const senhaHash = await bcrypt.hash(args.senha, 12);
        const codigo = gerarCodigoConfirmacao();
        const { error } = await criarPendente({
          tipo: 'cliente',
          email,
          empresa_id: ctx.empresaId,
          codigo,
          dados: { nome: args.nome, nascimento: null, telefone: ctx.telefone, senha: senhaHash, empresa_id: ctx.empresaId }
        });
        if (error) return { erro: 'Não consegui gerar o código agora, tente de novo em instantes.' };

        enviarEmailCodigoCadastro(email, args.nome, codigo);
        return { ok: true, email, mensagem: `Código de confirmação enviado para ${email}. Peça o código de 6 dígitos ao cliente e chame confirmar_codigo_cadastro.` };
      }

      case 'confirmar_codigo_cadastro': {
        const email = String(args.email || '').toLowerCase().trim();
        const pendente = email ? await buscarPendenteValido({ tipo: 'cliente', email, codigo: String(args.codigo || '') }) : null;
        if (!pendente) return { erro: 'Código inválido, expirado, ou e-mail não confere. Confirme os dois com o cliente (ou chame iniciar_cadastro de novo).' };

        const { nome, nascimento, telefone: telefonePendente, senha, empresa_id } = pendente.dados;
        const { error } = await supabase
          .from('usuarios')
          .insert({ nome_completo: nome, data_nascimento: nascimento, email, telefone: telefonePendente, senha, empresa_id, ativo: true, tipo: 'cliente' });
        if (error) return { erro: 'Não consegui concluir o cadastro agora, tente de novo em instantes.' };

        await removerPendente(pendente.id);
        return { ok: true, mensagem: 'Cadastro concluído — pode seguir com o agendamento.' };
      }

      case 'criar_agendamento': {
        if (await limiteAgendamentosMesAtingido(ctx.empresaId)) {
          return { erro: 'Este estabelecimento atingiu o limite de agendamentos do mês. Avise o cliente para tentar novamente em breve.' };
        }

        const { data: barbeiro } = await supabase
          .from('barbeiros').select('id, nome').eq('id', args.barbeiro_id).eq('empresa_id', ctx.empresaId).eq('ativo', true).maybeSingle();
        if (!barbeiro) return { erro: 'Profissional inválido ou inativo — chame listar_barbeiros de novo.' };

        const { data: servico } = await supabase
          .from('servicos').select('id, nome, valor, duracao').eq('id', args.servico_id).eq('empresa_id', ctx.empresaId).eq('ativo', true).maybeSingle();
        if (!servico) return { erro: 'Serviço inválido ou inativo — chame listar_servicos de novo.' };

        const dataISO = parseDataFalada(String(args.data || ''));
        if (!dataISO) return { erro: 'Data inválida.' };

        const slots = await horariosDisponiveis(ctx.empresaId, args.barbeiro_id, dataISO);
        if (!slots.includes(args.hora)) return { erro: 'Esse horário não está mais livre. Ofereça outro.', horarios_livres: slots };

        const cliente = await encontrarClientePorTelefone(ctx.empresaId, ctx.telefone);
        if (!cliente) return { erro: 'Cliente ainda não tem cadastro. Use iniciar_cadastro e confirmar_codigo_cadastro antes de tentar de novo.' };

        const resultado = await inserirAgendamento({
          empresaId: ctx.empresaId,
          usuarioId: cliente.id,
          barbeiroId: barbeiro.id,
          dataHora: `${dataISO}T${args.hora}:00`,
          servicoValor: servico.valor,
          servicoDuracao: servico.duracao,
          clienteNome: cliente.nome_completo
        });
        if (resultado.conflito) return { erro: 'Esse horário acabou de ser reservado por outra pessoa. Ofereça outro horário.' };
        if (!resultado.ok) return { erro: 'Não consegui criar o agendamento agora, tente de novo em instantes.' };

        const { data: empresaPix } = await supabase.from('empresas').select('mercadopago_access_token').eq('id', ctx.empresaId).maybeSingle();
        return {
          ok: true,
          agendamento_id: resultado.id,
          resumo: `${servico.nome} com ${barbeiro.nome} em ${dataISO.split('-').reverse().join('/')} às ${args.hora}`,
          valor: Number(servico.valor),
          pix_disponivel: !!empresaPix?.mercadopago_access_token
        };
      }

      case 'listar_meus_agendamentos': {
        const cliente = await encontrarClientePorTelefone(ctx.empresaId, ctx.telefone);
        if (!cliente) return { agendamentos: [] };
        const { data: futuros } = await supabase
          .from('agendamentos')
          .select('id, data_hora, barbeiros(nome)')
          .eq('usuario_id', cliente.id)
          .eq('empresa_id', ctx.empresaId)
          .in('status', ['pendente', 'confirmado'])
          .gte('data_hora', paraConvencaoDoBanco(new Date()).toISOString())
          .order('data_hora', { ascending: true })
          .limit(10);
        return { agendamentos: (futuros || []).map((a) => ({ id: a.id, data_hora: a.data_hora, profissional: a.barbeiros?.nome || null })) };
      }

      case 'cancelar_agendamento': {
        const cliente = await encontrarClientePorTelefone(ctx.empresaId, ctx.telefone);
        const { data: agendamento } = await supabase
          .from('agendamentos').select('id, usuario_id').eq('id', args.agendamento_id).eq('empresa_id', ctx.empresaId).maybeSingle();
        if (!agendamento || !cliente || agendamento.usuario_id !== cliente.id) {
          return { erro: 'Agendamento não encontrado ou não pertence a este cliente.' };
        }
        const { error } = await supabase
          .from('agendamentos')
          .update({ status: 'cancelado', justificativa_cancelamento: 'Cancelado pelo cliente via WhatsApp', cancelado_por: 'cliente' })
          .eq('id', args.agendamento_id);
        if (error) return { erro: 'Não consegui cancelar agora, tente de novo.' };
        return { ok: true };
      }

      case 'gerar_pix': {
        const cliente = await encontrarClientePorTelefone(ctx.empresaId, ctx.telefone);
        const { data: agendamento } = await supabase
          .from('agendamentos')
          .select('id, usuario_id, valor_total, pagamento_status')
          .eq('id', args.agendamento_id)
          .eq('empresa_id', ctx.empresaId)
          .maybeSingle();
        if (!agendamento || !cliente || agendamento.usuario_id !== cliente.id) {
          return { erro: 'Agendamento não encontrado ou não pertence a este cliente.' };
        }
        if (agendamento.pagamento_status === 'pago') return { erro: 'Esse agendamento já está pago.' };

        const { data: empresa } = await supabase.from('empresas').select('nome, mercadopago_access_token').eq('id', ctx.empresaId).maybeSingle();
        if (!empresa?.mercadopago_access_token) return { erro: 'Pagamento via Pix não está disponível para este estabelecimento.' };

        const valor = Number(agendamento.valor_total);
        const taxaPercentual = await obterTaxaMarketplace(ctx.empresaId);
        const cobranca = await criarPagamentoPix({
          accessTokenVendedor: empresa.mercadopago_access_token,
          valor,
          descricao: `SchedNext — atendimento em ${empresa.nome}`,
          externalReference: agendamento.id,
          applicationFee: valor * (taxaPercentual / 100)
        });
        await supabase.from('agendamentos').update({ mercadopago_payment_id: String(cobranca.id), pagamento_status: 'pendente' }).eq('id', agendamento.id);

        const qrBase64 = cobranca.point_of_interaction?.transaction_data?.qr_code_base64;
        const qrCode = cobranca.point_of_interaction?.transaction_data?.qr_code;
        if (!qrCode) return { erro: 'Não consegui gerar o Pix agora.' };

        if (qrBase64) await enviarImagem(ctx.instancia, ctx.telefone, qrBase64, `Pix de R$ ${valor.toFixed(2)}`);
        await enviarMensagem(ctx.instancia, ctx.telefone, `Código Pix Copia e Cola:\n${qrCode}`);

        return { ok: true, mensagem: 'QR Code e código Pix já foram enviados ao cliente. Avise que o pagamento é confirmado automaticamente assim que cair — não é preciso fazer mais nada.' };
      }

      default:
        return { erro: `Ferramenta desconhecida: ${nome}` };
    }
  } catch (err) {
    console.error(`Erro ao executar a ferramenta "${nome}" do agente de WhatsApp:`, err);
    return { erro: 'Erro interno ao executar essa ação, tente de novo em instantes.' };
  }
}

async function processar({ empresaId, telefone, texto, instancia, config }) {
  const sessao = await obterOuCriarSessao(empresaId, telefone);
  const dados = sessao.dados_temporarios || {};
  const historico = Array.isArray(dados.historico) ? dados.historico : [];
  const msg = (texto || '').trim();

  // Saída de emergência: nunca decidida pela IA, sempre disponível — garante que o cliente
  // sempre consegue zerar a conversa mesmo se o agente estiver travado ou se comportando mal.
  if (msg.toLowerCase() === 'sair') {
    await enviarMensagem(instancia, telefone, 'Até logo! 👋 Quando quiser, é só chamar de novo.');
    await salvarSessao(sessao, 'ia_livre', { historico: [] });
    return;
  }

  const sistema = montarSistema(config, historico.length === 0);
  const mensagens = [...historico, { role: 'user', content: msg }];
  const ferramentas = definirFerramentas();
  const ctx = { empresaId, telefone, instancia };

  let respostaFinal = '';
  for (let rodada = 0; rodada < MAX_RODADAS_FERRAMENTA; rodada++) {
    let resultado;
    try {
      resultado = await chat({ mensagens, sistema, temperatura: config.temperatura, maxTokens: 300, tools: ferramentas });
    } catch (err) {
      console.error('Erro ao chamar a Groq no modo livre do bot de WhatsApp:', err);
      respostaFinal = 'Desculpe, tive um problema técnico agora. Pode repetir o que você precisa?';
      break;
    }

    if (!resultado.toolCalls || resultado.toolCalls.length === 0) {
      respostaFinal = resultado.content || 'Desculpe, não entendi. Pode reformular?';
      break;
    }

    mensagens.push({ role: 'assistant', content: resultado.content || null, tool_calls: resultado.toolCalls });

    for (const chamada of resultado.toolCalls) {
      const args = parseArgsSeguro(chamada.function?.arguments);
      const saida = await executarFerramenta(chamada.function?.name, args, ctx);
      mensagens.push({ role: 'tool', tool_call_id: chamada.id, content: JSON.stringify(saida) });
    }

    if (rodada === MAX_RODADAS_FERRAMENTA - 1) {
      respostaFinal = 'Deixa eu confirmar isso direitinho — pode me dizer de novo o que você precisa?';
    }
  }

  await enviarMensagem(instancia, telefone, respostaFinal);

  const novoHistorico = [...historico, { role: 'user', content: msg }, { role: 'assistant', content: respostaFinal }].slice(-MAX_HISTORICO);
  await salvarSessao(sessao, 'ia_livre', { historico: novoHistorico });
}

module.exports = { processar };
