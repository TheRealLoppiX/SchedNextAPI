const cron = require('node-cron');
const supabase = require('../config/supabase');
const { enviarMensagemCliente } = require('../services/mensagensCliente');

const UM_DIA_MS = 24 * 60 * 60 * 1000;

// Janela de inatividade que dispara a recuperação automática: a partir de 45 dias sem um
// atendimento concluído, até 60 dias (depois disso paramos de tentar sozinhos — o negócio
// ainda pode mandar manualmente pela tela de Clientes a qualquer momento).
const DIAS_INATIVIDADE_MIN = 45;
const DIAS_INATIVIDADE_JANELA = 60;
// Não manda recuperação de novo pro mesmo cliente antes disso, mesmo que ele continue inativo.
const DIAS_RECORRENCIA_MINIMA = 90;

function iniciarRecuperacaoClientes() {
  cron.schedule('0 10 * * *', async () => {
    console.log('Verificando aniversariantes e clientes inativos para recuperação automática...');
    await processarAniversariantes().catch((err) => console.error('Erro no lote de aniversariantes:', err));
    await processarClientesInativos().catch((err) => console.error('Erro no lote de recuperação de inativos:', err));
  });
}

// data_nascimento é uma coluna DATE (sem hora). "2026-05-14" vira meia-noite UTC quando passado
// pro Date(), então comparar com getUTCMonth/getUTCDate evita o bug clássico de "aniversário no
// dia errado" que já aconteceu antes no admin (ver frontend/src/utils/dataSemFuso.js).
function ehAniversarioHoje(dataNascimento, hoje) {
  const nasc = new Date(dataNascimento);
  return nasc.getUTCMonth() === hoje.getMonth() && nasc.getUTCDate() === hoje.getDate();
}

async function processarAniversariantes() {
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();

  const { data: clientes, error } = await supabase
    .from('usuarios')
    .select('id, nome_completo, email, telefone, data_nascimento, ultimo_aniversario_enviado_ano, empresas!inner(nome, whatsapp_phone_number_id, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot))')
    .eq('tipo', 'cliente')
    .eq('ativo', true)
    .not('data_nascimento', 'is', null);

  if (error) return console.error('Erro ao buscar aniversariantes:', error);

  for (const cliente of clientes || []) {
    if (cliente.ultimo_aniversario_enviado_ano === anoAtual) continue;
    if (!ehAniversarioHoje(cliente.data_nascimento, hoje)) continue;

    try {
      await enviarMensagemCliente({
        tipo: 'aniversario',
        cliente,
        nomeEmpresa: cliente.empresas?.nome || 'Seu estabelecimento',
        canais: { email: true, whatsapp: !!cliente.empresas?.plano_plataforma?.permite_whatsapp_bot },
        instancia: cliente.empresas?.whatsapp_phone_number_id
      });
      await supabase.from('usuarios').update({ ultimo_aniversario_enviado_ano: anoAtual }).eq('id', cliente.id);
      console.log(`Aniversário enviado pro cliente ${cliente.id}.`);
    } catch (err) {
      console.error(`Erro ao enviar aniversário pro cliente ${cliente.id}:`, err);
    }
  }
}

async function processarClientesInativos() {
  const agora = Date.now();
  const limiteRecente = new Date(agora - DIAS_INATIVIDADE_MIN * UM_DIA_MS);
  const limiteAntigo = new Date(agora - DIAS_INATIVIDADE_JANELA * UM_DIA_MS);
  const limiteRecorrencia = new Date(agora - DIAS_RECORRENCIA_MINIMA * UM_DIA_MS);

  // Sem uma coluna materializada de "último atendimento", agregamos em JS a partir de todos os
  // agendamentos concluídos da plataforma. Aceitável rodando 1x/dia fora do caminho de requisição
  // de usuário nenhum; se a base crescer muito isso vira candidato a virar uma view/coluna.
  const { data: agendamentos, error } = await supabase
    .from('agendamentos')
    .select('usuario_id, data_hora')
    .eq('status', 'concluido')
    .not('usuario_id', 'is', null);

  if (error) return console.error('Erro ao buscar histórico de agendamentos p/ recuperação:', error);

  const ultimoPorCliente = {};
  for (const a of agendamentos || []) {
    const dh = new Date(a.data_hora);
    if (!ultimoPorCliente[a.usuario_id] || dh > ultimoPorCliente[a.usuario_id]) {
      ultimoPorCliente[a.usuario_id] = dh;
    }
  }

  const candidatosIds = Object.entries(ultimoPorCliente)
    .filter(([, ultima]) => ultima <= limiteRecente && ultima > limiteAntigo)
    .map(([id]) => Number(id));

  if (candidatosIds.length === 0) return;

  const { data: clientes, error: errClientes } = await supabase
    .from('usuarios')
    .select('id, nome_completo, email, telefone, ultima_recuperacao_enviada_em, empresas!inner(nome, whatsapp_phone_number_id, plano_plataforma:plano_plataforma_id(permite_whatsapp_bot))')
    .in('id', candidatosIds)
    .eq('tipo', 'cliente')
    .eq('ativo', true);

  if (errClientes) return console.error('Erro ao buscar clientes p/ recuperação:', errClientes);

  for (const cliente of clientes || []) {
    if (cliente.ultima_recuperacao_enviada_em && new Date(cliente.ultima_recuperacao_enviada_em) > limiteRecorrencia) continue;

    try {
      await enviarMensagemCliente({
        tipo: 'saudade',
        cliente,
        nomeEmpresa: cliente.empresas?.nome || 'Seu estabelecimento',
        canais: { email: true, whatsapp: !!cliente.empresas?.plano_plataforma?.permite_whatsapp_bot },
        instancia: cliente.empresas?.whatsapp_phone_number_id
      });
      await supabase.from('usuarios').update({ ultima_recuperacao_enviada_em: new Date().toISOString() }).eq('id', cliente.id);
      console.log(`Recuperação de cliente inativo enviada pro cliente ${cliente.id}.`);
    } catch (err) {
      console.error(`Erro ao enviar recuperação pro cliente ${cliente.id}:`, err);
    }
  }
}

module.exports = iniciarRecuperacaoClientes;
