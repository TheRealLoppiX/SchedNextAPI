const supabase = require('../../config/supabase');

// Horário de funcionamento do bot de WhatsApp (ver sql/2026_whatsapp_bot_horario.sql). Tudo em
// horário de Brasília: o servidor roda em UTC, então o dia/hora locais saem sempre do Intl.
const FUSO = 'America/Sao_Paulo';
const NOMES_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const PASSO_MIN = 5;
const MENSAGEM_PADRAO = 'Olá! No momento estamos fora do horário de atendimento pelo WhatsApp. Voltamos {volta}. Até já!';

const formatador = new Intl.DateTimeFormat('en-US', { timeZone: FUSO, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
const DIAS_EN = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function momentoLocal(data) {
  const p = Object.fromEntries(formatador.formatToParts(data).map((x) => [x.type, x.value]));
  return { dia: DIAS_EN[p.weekday], minutos: Number(p.hour) * 60 + Number(p.minute), dataStr: `${p.year}-${p.month}-${p.day}` };
}

const paraMinutos = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

// Config da empresa normalizada. Qualquer falha de leitura (ex: colunas ainda não criadas no
// banco) cai em "24h", que é exatamente como o bot sempre funcionou.
async function obterHorarioBot(empresaId) {
  const { data, error } = await supabase
    .from('empresas')
    .select('whatsapp_bot_horario_ativo, whatsapp_bot_horario_inicio, whatsapp_bot_horario_fim, whatsapp_bot_horario_dias, whatsapp_bot_mensagem_fora')
    .eq('id', empresaId)
    .maybeSingle();
  if (error || !data) return { ativo: false };
  return {
    ativo: !!data.whatsapp_bot_horario_ativo,
    inicio: data.whatsapp_bot_horario_inicio || '09:00',
    fim: data.whatsapp_bot_horario_fim || '18:00',
    dias: (data.whatsapp_bot_horario_dias || '0,1,2,3,4,5,6').split(',').map((d) => Number(d)).filter((d) => d >= 0 && d <= 6),
    mensagemFora: data.whatsapp_bot_mensagem_fora || ''
  };
}

// Está dentro do horário? Janela pode virar a meia-noite (ex: 18:00 às 02:00): nesse caso a parte
// depois da meia-noite pertence ao dia em que a janela começou.
function dentroDoHorario(cfg, data = new Date()) {
  if (!cfg || !cfg.ativo) return true;
  const inicio = paraMinutos(cfg.inicio);
  const fim = paraMinutos(cfg.fim);
  if (inicio === null || fim === null || cfg.dias.length === 0) return true; // config incompleta: não bloqueia
  const dias = new Set(cfg.dias);
  const { dia, minutos } = momentoLocal(data);
  if (inicio === fim) return dias.has(dia); // mesmo horário de início e fim = dia inteiro
  if (inicio < fim) return dias.has(dia) && minutos >= inicio && minutos < fim;
  return (dias.has(dia) && minutos >= inicio) || (dias.has((dia + 6) % 7) && minutos < fim);
}

// Próximo momento em que o bot volta, em texto ("hoje às 09:00", "amanhã às 09:00", "segunda às 09:00").
function textoVolta(cfg, agora = new Date()) {
  const hoje = momentoLocal(agora).dataStr;
  const amanha = momentoLocal(new Date(agora.getTime() + 24 * 3600000)).dataStr;
  for (let t = agora.getTime(); t < agora.getTime() + 8 * 24 * 3600000; t += PASSO_MIN * 60000) {
    const d = new Date(t);
    if (!dentroDoHorario(cfg, d)) continue;
    const local = momentoLocal(d);
    const hora = `${String(Math.floor(local.minutos / 60)).padStart(2, '0')}:${String(local.minutos % 60).padStart(2, '0')}`;
    // arredonda pro horário cadastrado (o passo de 5 min pode cair uns minutos depois dele)
    const horaExibida = cfg.inicio && Math.abs(paraMinutos(cfg.inicio) - local.minutos) < PASSO_MIN ? cfg.inicio : hora;
    const quando = local.dataStr === hoje ? 'hoje' : local.dataStr === amanha ? 'amanhã' : NOMES_DIA[local.dia];
    return `${quando} às ${horaExibida}`;
  }
  return 'em breve';
}

// Houve algum momento de horário aberto entre `desde` e agora? Serve pra avisar uma vez só por
// período fechado: se o bot já avisou e o horário não abriu desde então, fica quieto.
function abriuDesde(cfg, desde, agora = new Date()) {
  const inicio = Math.max(desde.getTime(), agora.getTime() - 8 * 24 * 3600000);
  for (let t = inicio; t <= agora.getTime(); t += PASSO_MIN * 60000) {
    if (dentroDoHorario(cfg, new Date(t))) return true;
  }
  return false;
}

// Chamado pelo webhook antes de passar a mensagem pro bot. Retorna true se o bot deve seguir
// respondendo normalmente; false se está fora do horário (e, se for o caso, já mandou o aviso).
async function liberarOuAvisarForaDoHorario({ empresaId, telefone, instancia, enviarMensagem }) {
  const cfg = await obterHorarioBot(empresaId);
  if (dentroDoHorario(cfg)) return true;

  const { data: aviso } = await supabase
    .from('whatsapp_avisos_fora_horario')
    .select('avisado_em')
    .eq('empresa_id', empresaId)
    .eq('telefone', telefone)
    .maybeSingle();

  if (!aviso || abriuDesde(cfg, new Date(aviso.avisado_em))) {
    const texto = (cfg.mensagemFora || MENSAGEM_PADRAO).replace(/\{volta\}/g, textoVolta(cfg));
    await enviarMensagem(instancia, telefone, texto);
    await supabase
      .from('whatsapp_avisos_fora_horario')
      .upsert({ empresa_id: empresaId, telefone, avisado_em: new Date().toISOString() }, { onConflict: 'empresa_id,telefone' });
  }
  return false;
}

module.exports = { liberarOuAvisarForaDoHorario, obterHorarioBot, dentroDoHorario, textoVolta, MENSAGEM_PADRAO };
