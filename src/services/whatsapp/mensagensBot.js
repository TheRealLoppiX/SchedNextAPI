const supabase = require('../../config/supabase');

// Textos do bot guiado (máquina de estados em bot.js), agrupados pelo estado da conversa em que
// aparecem. Três camadas, da mais forte pra mais fraca:
//   1. empresas.whatsapp_bot_mensagens (jsonb) — o que a empresa editou no próprio painel;
//   2. plataforma_configuracoes['whatsapp_bot_mensagens'] — padrão definido pelo admin absoluto;
//   3. `padrao` deste catálogo — texto de fábrica, usado quando nenhum dos dois acima existe.
// Chave ausente/vazia numa camada = cai pra próxima. Ver sql/2026_whatsapp_bot_mensagens.sql.
//
// Variáveis entre chaves ({lista}, {nome}...) são trocadas na hora do envio (ver renderizar).
// `obrigatoria`: se a empresa apagar a variável do texto, ela é anexada no fim mesmo assim —
// sem a lista numerada o cliente não tem como responder com o número da opção.
// `opcional`: quando vem vazia (ex: empresa sem link de site), a LINHA inteira que a contém some.

const CHAVE_PLATAFORMA = 'whatsapp_bot_mensagens';
const TAMANHO_MAXIMO = 1000;

const V = {
  opcoes: { nome: 'opcoes', descricao: 'lista numerada do menu (1. Agendar, 2. Ver agendamentos)', obrigatoria: true },
  saudacao: { nome: 'saudacao', descricao: 'mensagem de boas-vindas da empresa (ou "Olá!")' },
  link: { nome: 'link', descricao: 'link do site da empresa (a linha some se não houver link)', opcional: true },
  jaLogado: { nome: 'ja_logado', descricao: '" (já logado)" quando o link entra direto na conta do cliente' },
  lista: { nome: 'lista', descricao: 'lista numerada de opções', obrigatoria: true },
  nome: { nome: 'nome', descricao: 'nome que o cliente digitou' },
  email: { nome: 'email', descricao: 'e-mail do cliente' },
  data: { nome: 'data', descricao: 'data do agendamento' },
  hora: { nome: 'hora', descricao: 'horário do agendamento' },
  profissional: { nome: 'profissional', descricao: 'nome do profissional' },
  servico: { nome: 'servico', descricao: 'nome do serviço' },
  valor: { nome: 'valor', descricao: 'valor do Pix (ex: 45.00)' },
  codigo: { nome: 'codigo', descricao: 'código Pix Copia e Cola', obrigatoria: true }
};

const GRUPOS = [
  {
    estado: 'Menu',
    descricao: 'Primeira mensagem da conversa e comandos que valem em qualquer momento.',
    mensagens: [
      { chave: 'menu', titulo: 'Menu principal', variaveis: [V.saudacao, V.opcoes, V.link, V.jaLogado],
        padrao: '{saudacao} O que deseja fazer?\n{opcoes}\n\nDigite o número, ou *SAIR* para encerrar.\nOu pelo site{ja_logado}: {link}' },
      { chave: 'menu_nao_entendi', titulo: 'Opção do menu não entendida', variaveis: [],
        padrao: 'Não entendi. Digite *1* para agendar ou *2* para ver seus agendamentos.' },
      { chave: 'cancelar_fluxo', titulo: 'Cliente digitou CANCELAR no meio do fluxo', variaveis: [V.opcoes],
        padrao: 'Ok, cancelei o que você estava fazendo.\n\nO que deseja fazer?\n{opcoes}\n\nDigite o número, ou *SAIR* para encerrar.' },
      { chave: 'sair', titulo: 'Cliente digitou SAIR', variaveis: [],
        padrao: 'Até logo! Quando quiser, é só chamar de novo.' },
      { chave: 'fallback', titulo: 'Mensagem fora de contexto', variaveis: [],
        padrao: 'Digite *MENU* para ver as opções.' }
    ]
  },
  {
    estado: 'Agendamento',
    descricao: 'Escolha de profissional, data, horário e serviço.',
    mensagens: [
      { chave: 'escolher_profissional', titulo: 'Escolher profissional', variaveis: [V.lista],
        padrao: 'Com quem você quer agendar?\n{lista}' },
      { chave: 'profissional_invalido', titulo: 'Profissional inválido', variaveis: [],
        padrao: 'Escolha um número válido da lista.' },
      { chave: 'sem_profissionais', titulo: 'Nenhum profissional disponível', variaveis: [],
        padrao: 'No momento não há profissionais disponíveis para agendamento.' },
      { chave: 'limite_mes', titulo: 'Limite de agendamentos do mês atingido', variaveis: [],
        padrao: 'Desculpe, este estabelecimento atingiu o limite de agendamentos do mês. Tente novamente em breve.' },
      { chave: 'pedir_data', titulo: 'Pedir a data', variaveis: [V.profissional],
        padrao: 'Para qual dia? Responda *hoje*, *amanha* ou uma data (dd/mm).' },
      { chave: 'data_invalida', titulo: 'Data não entendida', variaveis: [],
        padrao: 'Não entendi a data. Responda *hoje*, *amanha* ou dd/mm.' },
      { chave: 'sem_horarios', titulo: 'Dia sem horários livres', variaveis: [],
        padrao: 'Não há horários livres nesse dia. Tente outra data.' },
      { chave: 'escolher_horario', titulo: 'Escolher horário', variaveis: [V.lista],
        padrao: 'Horários livres:\n{lista}' },
      { chave: 'horario_invalido', titulo: 'Horário inválido', variaveis: [],
        padrao: 'Escolha um número válido da lista de horários.' },
      { chave: 'escolher_servico', titulo: 'Escolher serviço', variaveis: [V.lista],
        padrao: 'Qual serviço?\n{lista}' },
      { chave: 'servico_invalido', titulo: 'Serviço inválido', variaveis: [],
        padrao: 'Escolha um número válido da lista de serviços.' },
      { chave: 'sem_servicos', titulo: 'Nenhum serviço cadastrado', variaveis: [],
        padrao: 'Nenhum serviço cadastrado para agendamento no momento.' }
    ]
  },
  {
    estado: 'Cadastro',
    descricao: 'Quando o número ainda não tem cadastro na empresa.',
    mensagens: [
      { chave: 'pedir_nome', titulo: 'Pedir o nome', variaveis: [],
        padrao: 'Não te encontrei no cadastro. Qual seu nome completo?' },
      { chave: 'nome_invalido', titulo: 'Nome muito curto', variaveis: [],
        padrao: 'Digite seu nome completo, por favor.' },
      { chave: 'pedir_email', titulo: 'Pedir o e-mail', variaveis: [V.nome],
        padrao: 'Prazer, {nome}! Agora preciso do seu e-mail pra confirmar o cadastro.' },
      { chave: 'email_invalido', titulo: 'E-mail inválido', variaveis: [],
        padrao: 'Esse e-mail não parece válido. Digite seu e-mail:' },
      { chave: 'email_ja_existe', titulo: 'E-mail já cadastrado', variaveis: [],
        padrao: 'Esse e-mail já tem cadastro por aqui. Digite outro e-mail, ou *SAIR* para cancelar.' },
      { chave: 'pedir_senha', titulo: 'Pedir a senha', variaveis: [],
        padrao: 'Show! Agora escolha uma senha (mínimo 6 caracteres), pode usar depois pra entrar no site como cliente.' },
      { chave: 'senha_curta', titulo: 'Senha muito curta', variaveis: [],
        padrao: 'A senha precisa ter pelo menos 6 caracteres. Digite uma senha:' },
      { chave: 'codigo_enviado', titulo: 'Código de confirmação enviado', variaveis: [V.email],
        padrao: 'Mandamos um código de confirmação para {email}. Digite o código aqui para concluir o cadastro (ou *REENVIAR* para receber um novo).' },
      { chave: 'codigo_reenviado', titulo: 'Código reenviado', variaveis: [],
        padrao: 'Novo código enviado! Digite ele aqui para concluir o cadastro.' },
      { chave: 'codigo_invalido', titulo: 'Código inválido', variaveis: [],
        padrao: 'Código inválido ou expirado. Confira o e-mail e digite de novo, ou *REENVIAR* para receber um novo código.' },
      { chave: 'cadastro_expirado', titulo: 'Cadastro pendente expirou', variaveis: [],
        padrao: 'Seu cadastro pendente expirou. Digite *MENU* para recomeçar.' },
      { chave: 'erro_gerar_codigo', titulo: 'Erro ao gerar o código', variaveis: [],
        padrao: 'Não consegui gerar o código de confirmação agora. Tente novamente em instantes.' },
      { chave: 'erro_cadastro', titulo: 'Erro ao concluir o cadastro', variaveis: [],
        padrao: 'Não consegui concluir seu cadastro agora. Tente novamente em instantes, ou digite *MENU*.' }
    ]
  },
  {
    estado: 'Confirmação',
    descricao: 'Fim do agendamento.',
    mensagens: [
      { chave: 'agendamento_confirmado', titulo: 'Agendamento confirmado', variaveis: [V.profissional, V.servico, V.data, V.hora, V.link, V.jaLogado],
        padrao: 'Agendamento confirmado!\n{profissional}, {servico}\n{data} às {hora}\n\nGerenciar pelo site{ja_logado}: {link}' },
      { chave: 'confirmado_rodape', titulo: 'Rodapé da confirmação (sem Pix)', variaveis: [],
        padrao: 'Digite *MENU* para agendar outro horário.' },
      { chave: 'horario_ocupado', titulo: 'Horário foi ocupado por outra pessoa', variaveis: [],
        padrao: 'Esse horário acabou de ser reservado por outra pessoa. Digite *MENU* para tentar outro horário.' },
      { chave: 'ja_tem_no_dia', titulo: 'Cliente já tem agendamento no dia', variaveis: [],
        padrao: 'Você já tem um agendamento marcado para esse dia. Cancele o atual antes de marcar outro, ou escolha outra data. Digite *MENU* para ver as opções.' },
      { chave: 'erro_agendamento', titulo: 'Erro ao agendar', variaveis: [],
        padrao: 'Não consegui concluir o agendamento agora. Tente novamente em instantes.' }
    ]
  },
  {
    estado: 'Pagamento Pix',
    descricao: 'Só aparece quando a empresa tem Mercado Pago conectado.',
    mensagens: [
      { chave: 'oferta_pix', titulo: 'Oferecer pagamento antecipado', variaveis: [],
        padrao: 'Quer adiantar o pagamento agora via Pix? Responda *SIM* ou *NAO*.' },
      { chave: 'pix_recusado', titulo: 'Cliente não quis pagar agora', variaveis: [],
        padrao: 'Sem problema, é só pagar direto no local. Digite *MENU* para agendar outro horário.' },
      { chave: 'pix_codigo', titulo: 'Envio do Pix Copia e Cola', variaveis: [V.codigo, V.valor],
        padrao: 'Código Pix Copia e Cola:\n{codigo}\n\nAssim que o pagamento cair, te aviso por aqui.' },
      { chave: 'pix_erro', titulo: 'Erro ao gerar o Pix', variaveis: [],
        padrao: 'Não consegui gerar o Pix agora. Pode pagar direto no local.' }
    ]
  },
  {
    estado: 'Meus agendamentos',
    descricao: 'Consulta e cancelamento de agendamentos pelo cliente.',
    mensagens: [
      { chave: 'lista_agendamentos', titulo: 'Lista de agendamentos', variaveis: [V.lista],
        padrao: 'Seus próximos agendamentos:\n{lista}\n\nDigite o número de um deles para cancelar, ou *MENU* para voltar.' },
      { chave: 'agendamento_invalido', titulo: 'Agendamento inválido', variaveis: [],
        padrao: 'Escolha um número válido da lista, ou digite *MENU* para voltar.' },
      { chave: 'sem_cadastro', titulo: 'Número sem cadastro', variaveis: [],
        padrao: 'Não encontrei nenhum cadastro com este número de telefone. Digite *MENU* para ver as opções.' },
      { chave: 'sem_agendamentos', titulo: 'Sem agendamentos futuros', variaveis: [],
        padrao: 'Você não tem nenhum agendamento futuro. Digite *MENU* para ver as opções.' },
      { chave: 'confirmar_cancelamento', titulo: 'Confirmar cancelamento', variaveis: [V.data, V.profissional],
        padrao: 'Confirma cancelar o agendamento de {data} com {profissional}?\nResponda *SIM* ou *NAO*.' },
      { chave: 'cancelamento_mantido', titulo: 'Cliente desistiu de cancelar', variaveis: [],
        padrao: 'Ok, mantive seu agendamento. Digite *MENU* para ver as opções.' },
      { chave: 'cancelado', titulo: 'Agendamento cancelado', variaveis: [V.data],
        padrao: 'Agendamento de {data} cancelado. Digite *MENU* para ver as opções.' },
      { chave: 'erro_cancelar', titulo: 'Erro ao cancelar', variaveis: [],
        padrao: 'Não consegui cancelar agora. Tente novamente em instantes.' }
    ]
  }
];

const POR_CHAVE = Object.fromEntries(GRUPOS.flatMap((g) => g.mensagens.map((m) => [m.chave, m])));
const CHAVES = Object.keys(POR_CHAVE);

// Mantém só chaves conhecidas com texto não vazio, e descarta o que é igual ao padrão de baixo
// (não faz sentido guardar como "personalizado" um texto idêntico ao que já seria usado).
function limparMensagens(entrada, padroesAbaixo = {}) {
  const limpo = {};
  for (const chave of CHAVES) {
    const texto = typeof entrada?.[chave] === 'string' ? entrada[chave].replace(/\r\n/g, '\n').trim() : '';
    if (!texto) continue;
    if (texto === (padroesAbaixo[chave] || POR_CHAVE[chave].padrao)) continue;
    limpo[chave] = texto.slice(0, TAMANHO_MAXIMO);
  }
  return limpo;
}

function analisarJson(valor) {
  if (!valor) return {};
  if (typeof valor === 'object') return valor;
  try { return JSON.parse(valor) || {}; } catch { return {}; }
}

// Cache curto: o webhook consulta isso a cada mensagem recebida de qualquer empresa.
let cachePlataforma = { valor: null, ate: 0 };
async function obterMensagensPlataforma({ semCache = false } = {}) {
  if (!semCache && cachePlataforma.valor && Date.now() < cachePlataforma.ate) return cachePlataforma.valor;
  const { data } = await supabase.from('plataforma_configuracoes').select('valor').eq('chave', CHAVE_PLATAFORMA).maybeSingle();
  const valor = limparMensagens(analisarJson(data?.valor));
  cachePlataforma = { valor, ate: Date.now() + 60 * 1000 };
  return valor;
}

async function salvarMensagensPlataforma(entrada) {
  const valor = limparMensagens(entrada);
  const { error } = await supabase
    .from('plataforma_configuracoes')
    .upsert({ chave: CHAVE_PLATAFORMA, valor: JSON.stringify(valor), atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
  if (error) throw error;
  cachePlataforma = { valor, ate: Date.now() + 60 * 1000 };
  return valor;
}

// Padrão efetivo de cada chave pra uma empresa que não personalizou nada.
async function obterPadroes() {
  const plataforma = await obterMensagensPlataforma();
  return Object.fromEntries(CHAVES.map((c) => [c, plataforma[c] || POR_CHAVE[c].padrao]));
}

// Tolerante a falha (ex: coluna ainda não criada no banco): sem personalização, o bot segue com
// os padrões, que é exatamente como ele funcionava antes.
async function obterMensagensEmpresa(empresaId) {
  const { data, error } = await supabase.from('empresas').select('whatsapp_bot_mensagens').eq('id', empresaId).maybeSingle();
  if (error || !data) return {};
  return limparMensagens(analisarJson(data.whatsapp_bot_mensagens));
}

function renderizar(chave, template, vars = {}) {
  const meta = POR_CHAVE[chave];
  const variaveis = meta?.variaveis || [];
  const vazias = new Set(variaveis.filter((v) => v.opcional && !vars[v.nome]).map((v) => v.nome));

  let texto = template;
  if (vazias.size) {
    texto = texto
      .split('\n')
      .filter((linha) => ![...vazias].some((nome) => linha.includes(`{${nome}}`)))
      .join('\n');
  }

  for (const v of variaveis) {
    if (v.obrigatoria && vars[v.nome] && !texto.includes(`{${v.nome}}`)) texto = `${texto}\n{${v.nome}}`;
  }

  texto = texto.replace(/\{([a-z_]+)\}/g, (inteiro, nome) => (
    variaveis.some((v) => v.nome === nome) ? String(vars[nome] ?? '') : inteiro
  ));
  return texto.replace(/\n{3,}/g, '\n\n').trim();
}

// Monta a função `msg(chave, vars)` usada pelo bot numa conversa: resolve as três camadas uma
// vez só (duas consultas, uma delas em cache) e depois só formata.
async function carregarMensagensBot(empresaId) {
  const [padroes, empresa] = await Promise.all([obterPadroes(), obterMensagensEmpresa(empresaId)]);
  return (chave, vars) => renderizar(chave, empresa[chave] || padroes[chave] || POR_CHAVE[chave]?.padrao || '', vars);
}

// Catálogo pra montar a tela de edição (sem o `obrigatoria`/`opcional` internos virarem regra no
// front — lá é só texto de ajuda).
function catalogo() {
  return GRUPOS.map((g) => ({
    estado: g.estado,
    descricao: g.descricao,
    mensagens: g.mensagens.map((m) => ({
      chave: m.chave,
      titulo: m.titulo,
      padraoFabrica: m.padrao,
      variaveis: m.variaveis.map((v) => ({ nome: v.nome, descricao: v.descricao }))
    }))
  }));
}

module.exports = {
  TAMANHO_MAXIMO,
  CHAVES,
  catalogo,
  limparMensagens,
  obterMensagensPlataforma,
  salvarMensagensPlataforma,
  obterPadroes,
  obterMensagensEmpresa,
  carregarMensagensBot,
  renderizar
};
