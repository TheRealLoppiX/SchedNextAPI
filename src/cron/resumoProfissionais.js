const cron = require('node-cron');
const supabase = require('../config/supabase');
const { enviarMensagem } = require('../services/whatsapp/provider');
const { paraConvencaoDoBanco } = require('../utils/horarioBrasilia');

// Resumo diário dos horários de cada profissional via WhatsApp, no horário configurado por
// empresa em Admin -> WhatsApp (whatsapp_resumo_profissionais_ativo/_horario, ver
// sql/2026_whatsapp_resumo_profissionais.sql). Roda todo minuto e compara com o horário
// configurado (texto 'HH:MM') — mesmo padrão de polling usado em cron/lembretes.js, só que aqui
// é "dispara uma vez por dia no minuto exato" em vez de "dispara numa janela antes do horário".
function iniciarResumoProfissionais() {
  let executando = false;
  cron.schedule('*/1 * * * *', async () => {
    // Mesma trava de sobreposição do cron de lembretes: evita reprocessar (e duplicar mensagem)
    // se um lote ainda estiver rodando quando o próximo minuto disparar.
    if (executando) return;
    executando = true;
    try {
      await processarResumoProfissionais();
    } finally {
      executando = false;
    }
  });
}

async function processarResumoProfissionais() {
  const agora = paraConvencaoDoBanco(new Date());
  const horarioAtual = `${String(agora.getUTCHours()).padStart(2, '0')}:${String(agora.getUTCMinutes()).padStart(2, '0')}`;
  const dataHoje = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}-${String(agora.getUTCDate()).padStart(2, '0')}`;

  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id, nome, whatsapp_phone_number_id, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot)')
    .eq('whatsapp_resumo_profissionais_ativo', true)
    .eq('whatsapp_resumo_profissionais_horario', horarioAtual)
    .not('whatsapp_phone_number_id', 'is', null);

  if (error) return console.error('Erro ao buscar empresas pro resumo diário de profissionais:', error);

  for (const empresa of empresas || []) {
    // Plano pode ter caído pra um que não inclui mais o bot depois do campo já ter sido ligado —
    // a rota que salva já reconfere no momento de salvar, mas o plano muda com o tempo.
    if (!empresa.plano_plataforma?.permite_whatsapp_bot) continue;

    try {
      await enviarResumoDaEmpresa(empresa, dataHoje);
    } catch (err) {
      console.error(`Erro ao enviar resumo diário de profissionais da empresa ${empresa.id}:`, err);
    }
  }
}

async function enviarResumoDaEmpresa(empresa, dataHoje) {
  const { data: barbeiros } = await supabase
    .from('barbeiros')
    .select('id, nome, telefone')
    .eq('empresa_id', empresa.id)
    .eq('ativo', true)
    .not('telefone', 'is', null);

  const dataFmt = dataHoje.split('-').reverse().join('/');

  for (const barbeiro of barbeiros || []) {
    try {
      const { data: agendamentos, error } = await supabase
        .from('agendamentos')
        .select('data_hora, cliente_nome, usuarios(nome_completo), agendamento_servicos(servicos(nome))')
        .eq('barbeiro_id', barbeiro.id)
        .gte('data_hora', `${dataHoje}T00:00:00`)
        .lte('data_hora', `${dataHoje}T23:59:59`)
        .neq('status', 'cancelado')
        .order('data_hora', { ascending: true });

      if (error) throw error;

      const texto = montarMensagemResumo(barbeiro.nome, dataFmt, agendamentos || []);
      await enviarMensagem(empresa.whatsapp_phone_number_id, `55${barbeiro.telefone.replace(/\D/g, '')}`, texto);
    } catch (err) {
      console.error(`Erro ao enviar resumo diário pro profissional ${barbeiro.id} (empresa ${empresa.id}):`, err);
    }
  }
}

// "Olá" em vez de "Bom dia" de propósito: o horário de disparo é configurável pela empresa e pode
// muito bem ser à tarde, então uma saudação fixa de manhã ficaria estranha em boa parte dos casos.
function montarMensagemResumo(nomeBarbeiro, dataFmt, agendamentos) {
  if (agendamentos.length === 0) {
    return `Olá, ${nomeBarbeiro}! Você não tem nenhum atendimento agendado para hoje (${dataFmt}).`;
  }

  const linhas = agendamentos.map((a) => {
    const hora = new Date(a.data_hora).toISOString().slice(11, 16);
    const nomeCliente = a.usuarios?.nome_completo || a.cliente_nome || 'Cliente';
    const servicos = (a.agendamento_servicos || []).map((as) => as.servicos?.nome).filter(Boolean).join(' + ') || 'Serviço';
    return `${hora} - ${nomeCliente} (${servicos})`;
  });

  return `Olá, ${nomeBarbeiro}! Seus atendimentos de hoje (${dataFmt}):\n${linhas.join('\n')}`;
}

module.exports = iniciarResumoProfissionais;
