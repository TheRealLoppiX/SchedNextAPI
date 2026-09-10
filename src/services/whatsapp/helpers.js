// Helpers de dados compartilhados pelos dois modos do bot de WhatsApp: o modo "guiado"
// (bot.js, máquina de estados de textos fixos) e o modo "livre" (agente.js, Groq com tool
// calling). Ficam num módulo à parte pra bot.js e agente.js não precisarem se importar um ao
// outro (bot.js despacha pro agente quando a empresa está em modo livre — um require circular
// bot.js <-> agente.js ia deixar os exports incompletos dependendo de quem carrega primeiro).
const supabase = require('../../config/supabase');
const transporter = require('../../config/mailer');
const { emailHtml, blocoCodigo } = require('../../utils/emailTemplate');
const { variantesTelefoneBR } = require('../../utils/telefone');
const { paraConvencaoDoBanco } = require('../../utils/horarioBrasilia');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

// Encontra o cliente cadastrado dono deste número, tolerando os formatos diferentes em que
// `usuarios.telefone` pode estar salvo (com máscara, sem DDI, com/sem o 9º dígito; ver
// utils/telefone.js). Sem isso, clientes já cadastrados pelo site quase nunca eram
// reconhecidos vindo do WhatsApp, caindo sempre no fluxo de "não te encontrei no cadastro".
async function encontrarClientePorTelefone(empresaId, waId) {
  const variantes = variantesTelefoneBR(waId);
  const sufixo = variantes[0].slice(-8);
  if (!sufixo) return null;

  const { data } = await supabase
    .from('usuarios')
    .select('id, nome_completo, telefone')
    .eq('empresa_id', empresaId)
    .ilike('telefone', `%${sufixo}%`);

  return (data || []).find((u) => variantesTelefoneBR(u.telefone).some((v) => variantes.includes(v))) || null;
}

// Manda o e-mail de código de confirmação de cadastro — mesmo template/assunto usado em
// POST /registrar (routes/auth.js), só pra manter a identidade visual consistente entre o
// cadastro pelo site e pelo WhatsApp.
function enviarEmailCodigoCadastro(email, nome, codigo) {
  transporter.sendMail({
    to: email,
    subject: 'Confirme seu cadastro - SchedNext',
    html: emailHtml({
      titulo: `Olá, ${nome}!`,
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Use o código abaixo para confirmar seu cadastro:</p>
        ${blocoCodigo(codigo)}
        <p style="margin: 0; color: #666; font-size: 13px;">Esse código expira em 30 minutos.</p>
      `
    })
  }, (mailErr) => {
    if (mailErr) console.error('Erro ao enviar e-mail de código de cadastro (bot do WhatsApp):', mailErr);
  });
}

function gerarCodigoConfirmacao() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// hoje.toISOString() usaria o dia em UTC, não em Brasília: alguém digitando "hoje" entre ~21h e
// meia-noite (horário de Brasília) cairia no dia seguinte, já virado em UTC. paraConvencaoDoBanco
// desloca pro mesmo "horário de parede" que o resto do projeto usa pra ler data local (ver
// utils/horarioBrasilia.js).
function dataLocalISO(instanteReal) {
  const d = paraConvencaoDoBanco(instanteReal);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseDataFalada(texto) {
  const hoje = new Date();
  const t = texto.trim().toLowerCase();
  // Formato ISO passa direto — o modo livre do bot (agente.js) devolve datas nesse formato pras
  // próprias ferramentas (ex: listar_horarios já respondeu com a data em ISO) e o modelo tende a
  // ecoar o mesmo valor de volta numa chamada seguinte (ex: criar_agendamento).
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (t === 'hoje') return dataLocalISO(hoje);
  if (t === 'amanha' || t === 'amanhã') {
    return dataLocalISO(new Date(hoje.getTime() + 24 * 60 * 60 * 1000));
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

// Mesma lógica de janela de funcionamento usada em routes/apiPublica.js (GET /disponibilidade) —
// sem isso, o bot oferecia horário das 8h às 20h todo santo dia, mesmo em dias marcados como
// fechados ou fora do horário de funcionamento configurado pela empresa.
async function horariosDisponiveis(empresaId, barbeiroId, dataStr) {
  const { data: empresa } = await supabase.from('empresas').select('horarios_funcionamento').eq('id', empresaId).maybeSingle();
  const diaSemana = new Date(`${dataStr}T00:00:00Z`).getUTCDay();
  const horarioDia = JSON.parse(empresa?.horarios_funcionamento || '{}')[diaSemana];
  if (!horarioDia || !horarioDia.aberto) return [];

  const { data: ocupados } = await supabase
    .from('agendamentos')
    .select('data_hora')
    .eq('barbeiro_id', barbeiroId)
    .gte('data_hora', `${dataStr}T00:00:00`)
    .lte('data_hora', `${dataStr}T23:59:59`)
    .neq('status', 'cancelado');

  const horasOcupadas = new Set((ocupados || []).map((a) => new Date(a.data_hora).toISOString().slice(11, 16)));

  const [horaAbre, minAbre] = horarioDia.abre.split(':').map(Number);
  const [horaFecha, minFecha] = horarioDia.fecha.split(':').map(Number);
  const slots = [];
  for (let min = horaAbre * 60 + minAbre; min < horaFecha * 60 + minFecha; min += 30) {
    const hStr = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    if (!horasOcupadas.has(hStr)) slots.push(hStr);
  }
  return slots;
}

// Cria o agendamento de fato, com a mesma checagem de corrida que já existia só no fluxo guiado:
// reduz a janela entre listar horários livres e confirmar de fato — sem reconferir aqui, duas
// conversas simultâneas escolhendo o mesmo profissional+horário resultavam em dois agendamentos
// confirmados pro mesmo slot (não há UNIQUE(barbeiro_id, data_hora) no banco). Compartilhada pelos
// dois modos do bot (guiado chama direto; livre chama via tool "criar_agendamento" no agente).
async function inserirAgendamento({ empresaId, usuarioId, barbeiroId, dataHora, servicoValor, servicoDuracao, clienteNome }) {
  const { data: conflito } = await supabase
    .from('agendamentos')
    .select('id')
    .eq('barbeiro_id', barbeiroId)
    .eq('data_hora', dataHora)
    .neq('status', 'cancelado')
    .maybeSingle();

  if (conflito) return { ok: false, conflito: true };

  const { data, error } = await supabase
    .from('agendamentos')
    .insert({
      usuario_id: usuarioId || null,
      empresa_id: empresaId,
      barbeiro_id: barbeiroId,
      data_hora: dataHora,
      status: 'confirmado',
      valor_total: servicoValor,
      duracao_total: servicoDuracao,
      cliente_nome: usuarioId ? null : clienteNome
    })
    .select('id')
    .single();

  if (error) return { ok: false, erro: error };
  return { ok: true, id: data.id };
}

module.exports = {
  EMAIL_REGEX,
  EXPIRACAO_SESSAO_MIN,
  obterOuCriarSessao,
  salvarSessao,
  listarBarbeirosAtivos,
  listarServicosAtivos,
  encontrarClientePorTelefone,
  enviarEmailCodigoCadastro,
  gerarCodigoConfirmacao,
  dataLocalISO,
  parseDataFalada,
  horariosDisponiveis,
  inserirAgendamento
};
