const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('./whatsapp/provider');
const { permiteWhatsappBot } = require('../utils/limitesPlano');

// Chamado depois de um checkout ser concluído (ver routes/agendamentos.js,
// POST /admin/finalizar-servico-checkout). Antes disso o cliente só descobria que bateu a meta
// da campanha de fidelidade se abrisse a tela dele mesmo (GET /fidelidade/:userId calculava sob
// demanda) — aqui a gente detecta e avisa automaticamente, uma única vez por campanha.
async function verificarEDispararPremioFidelidade(usuarioId, empresaId) {
  if (!usuarioId) return;

  try {
    const { data: campanha } = await supabase
      .from('campanhas_fidelidade')
      .select('*')
      .eq('empresa_id', empresaId)
      .eq('ativa', true)
      .limit(1)
      .maybeSingle();

    if (!campanha) return;

    // Já notificado pra essa campanha? Não manda de novo (UNIQUE(usuario_id, campanha_id)
    // garante isso mesmo sob corrida de duas requisições simultâneas).
    const { data: jaNotificado } = await supabase
      .from('fidelidade_premios_notificados')
      .select('id')
      .eq('usuario_id', usuarioId)
      .eq('campanha_id', campanha.id)
      .maybeSingle();
    if (jaNotificado) return;

    // Mesma contagem de elegibilidade usada em GET /fidelidade/:userId (routes/perfil.js) —
    // manter as duas em sincronia se essa regra mudar.
    const { count } = await supabase
      .from('agendamentos')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_id', usuarioId)
      .eq('status', 'concluido')
      .gte('data_hora', `${campanha.data_inicio}T00:00:00`)
      .lte('data_hora', `${campanha.data_fim}T23:59:59`)
      .gte('valor_total', campanha.valor_minimo);

    if ((count || 0) < campanha.cortes_necessarios) return;

    const { data: inserido } = await supabase
      .from('fidelidade_premios_notificados')
      .insert({ usuario_id: usuarioId, campanha_id: campanha.id })
      .select('id')
      .maybeSingle();
    // Se o insert não "pegou" (conflito de UNIQUE — outra requisição chegou primeiro), não manda.
    if (!inserido) return;

    const { data: usuario } = await supabase
      .from('usuarios')
      .select('nome_completo, email, telefone')
      .eq('id', usuarioId)
      .maybeSingle();
    if (!usuario) return;

    const { data: empresa } = await supabase.from('empresas').select('nome, whatsapp_phone_number_id').eq('id', empresaId).maybeSingle();
    const nomeEmpresa = empresa?.nome || 'Seu estabelecimento';
    const primeiroNome = (usuario.nome_completo || '').split(' ')[0] || 'Cliente';
    const textoPremio = campanha.premio_descritivo || 'seu prêmio';

    if (usuario.email) {
      await transporter.sendMail({
        to: usuario.email,
        subject: `Parabéns, ${primeiroNome}! Você ganhou ${textoPremio}`,
        html: emailHtml({
          titulo: `Parabéns, ${primeiroNome}!`,
          mensagemHtml: `
            <p style="margin: 0 0 4px;">Você completou a campanha <strong>${campanha.nome}</strong> da <strong>${nomeEmpresa}</strong>!</p>
            <p style="margin: 12px 0;">Seu prêmio: <strong>${textoPremio}</strong>. Aproveite no seu próximo atendimento.</p>
          `
        })
      });
    }

    if (usuario.telefone && (await permiteWhatsappBot(empresaId))) {
      await enviarMensagem(
        empresa?.whatsapp_phone_number_id,
        `55${usuario.telefone.replace(/\D/g, '')}`,
        `Parabéns, ${primeiroNome}! Você completou a campanha "${campanha.nome}" da ${nomeEmpresa} e ganhou ${textoPremio}. Aproveite no seu próximo atendimento!`
      );
    }
  } catch (err) {
    console.error('Erro ao verificar/disparar prêmio de fidelidade:', err);
  }
}

// Notifica todos os clientes da empresa sobre uma campanha de fidelidade recém-criada (ver POST
// /admin/acoes em routes/fidelidade.js). Fire-and-forget de propósito — o caller não faz await
// nisso, pra criar a campanha não ficar esperando o envio de e-mail/WhatsApp pra centenas de
// clientes antes de responder ao admin. Sequencial (não Promise.all), mesmo motivo do cron de
// lembretes (cron/lembretes.js): não afogar a Evolution API/SMTP com um monte de chamada de uma
// vez só.
async function notificarNovaCampanhaFidelidade(empresaId, campanha) {
  try {
    const { data: clientes } = await supabase
      .from('usuarios')
      .select('id, nome_completo, email, telefone')
      .eq('empresa_id', empresaId)
      .eq('tipo', 'cliente')
      .eq('ativo', true);

    if (!clientes || clientes.length === 0) return;

    const { data: empresa } = await supabase.from('empresas').select('nome, whatsapp_phone_number_id').eq('id', empresaId).maybeSingle();
    const nomeEmpresa = empresa?.nome || 'Seu estabelecimento';
    const permiteBot = await permiteWhatsappBot(empresaId);

    const metaTexto = `${campanha.cortes_necessarios} atendimento${campanha.cortes_necessarios === 1 ? '' : 's'}`;
    const periodoTexto = `${campanha.data_inicio.split('-').reverse().join('/')} até ${campanha.data_fim.split('-').reverse().join('/')}`;
    const premioTexto = campanha.premio_descritivo || 'uma recompensa especial';

    for (const cliente of clientes) {
      try {
        const primeiroNome = (cliente.nome_completo || '').split(' ')[0] || 'Cliente';

        if (cliente.email) {
          await transporter.sendMail({
            to: cliente.email,
            subject: `${nomeEmpresa} tem uma campanha nova: ${campanha.nome}`,
            html: emailHtml({
              titulo: `Novidade da ${nomeEmpresa}!`,
              mensagemHtml: `
                <p style="margin: 0 0 4px;">Olá, ${primeiroNome}! A campanha <strong>${campanha.nome}</strong> já está valendo, de ${periodoTexto}.</p>
                <p style="margin: 12px 0;">Complete ${metaTexto} nesse período e ganhe: <strong>${premioTexto}</strong>.</p>
              `
            })
          });
        }

        if (cliente.telefone && permiteBot) {
          await enviarMensagem(
            empresa?.whatsapp_phone_number_id,
            `55${cliente.telefone.replace(/\D/g, '')}`,
            `${nomeEmpresa} tem uma campanha nova: "${campanha.nome}"! Complete ${metaTexto} entre ${periodoTexto} e ganhe ${premioTexto}.`
          );
        }
      } catch (err) {
        console.error(`Erro ao notificar cliente ${cliente.id} sobre nova campanha de fidelidade:`, err);
      }
    }
  } catch (err) {
    console.error('Erro ao notificar clientes sobre nova campanha de fidelidade:', err);
  }
}

// ============================ Cortesia (resgate do prêmio no caixa) ============================
// Quem bateu a meta de uma ação ganha o prêmio UMA vez por ação (fidelidade_resgates, UNIQUE
// usuario_id + campanha_id). O prêmio fica guardado até ser usado no fechamento de caixa de um
// atendimento seguinte, mesmo que a ação já tenha encerrado. Ver sql/2026_fidelidade_premio_resgate.sql.

const TIPOS_PREMIO_AUTOMATICO = ['servico', 'produto', 'desconto_percentual', 'desconto_valor'];
const arredondar = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Mesma contagem de elegibilidade de GET /fidelidade/:userId e de verificarEDispararPremioFidelidade.
async function contarAtendimentosNaAcao(usuarioId, campanha) {
  const { count } = await supabase
    .from('agendamentos')
    .select('id', { count: 'exact', head: true })
    .eq('usuario_id', usuarioId)
    .eq('status', 'concluido')
    .gte('data_hora', `${campanha.data_inicio}T00:00:00`)
    .lte('data_hora', `${campanha.data_fim}T23:59:59`)
    .gte('valor_total', campanha.valor_minimo || 0);
  return count || 0;
}

async function detalharPremio(campanha) {
  const premio = {
    campanha_id: campanha.id,
    campanha_nome: campanha.nome,
    tipo: TIPOS_PREMIO_AUTOMATICO.includes(campanha.tipo_premio) ? campanha.tipo_premio : 'manual',
    descricao: campanha.premio_descritivo,
    valor: campanha.premio_valor != null ? Number(campanha.premio_valor) : null,
    servico: null,
    produto: null
  };
  if (premio.tipo === 'servico' && campanha.premio_servico_id) {
    const { data } = await supabase.from('servicos').select('id, nome, valor').eq('id', campanha.premio_servico_id).maybeSingle();
    premio.servico = data ? { id: data.id, nome: data.nome, valor: Number(data.valor) || 0 } : null;
  }
  if (premio.tipo === 'produto' && campanha.premio_produto_id) {
    const { data } = await supabase.from('produtos').select('id, nome, valor').eq('id', campanha.premio_produto_id).maybeSingle();
    premio.produto = data ? { id: data.id, nome: data.nome, valor: Number(data.valor) || 0 } : null;
  }
  // Serviço/produto do prêmio apagado depois: sem o item não há o que dar de graça, vira manual.
  if ((premio.tipo === 'servico' && !premio.servico) || (premio.tipo === 'produto' && !premio.produto)) premio.tipo = 'manual';
  if ((premio.tipo === 'desconto_percentual' || premio.tipo === 'desconto_valor') && !(premio.valor > 0)) premio.tipo = 'manual';
  return premio;
}

// Prêmio que o cliente já conquistou e ainda não usou, ou null. Olha as ações mais recentes da
// empresa (a ativa primeiro).
async function obterPremioDisponivel(usuarioId, empresaId) {
  if (!usuarioId || !empresaId) return null;

  const { data: campanhas } = await supabase
    .from('campanhas_fidelidade')
    .select('id, nome, data_inicio, data_fim, cortes_necessarios, valor_minimo, premio_descritivo, tipo_premio, premio_servico_id, premio_produto_id, premio_valor, ativa')
    .eq('empresa_id', empresaId)
    .order('ativa', { ascending: false })
    .order('data_fim', { ascending: false })
    .limit(10);
  if (!campanhas || campanhas.length === 0) return null;

  const { data: resgates } = await supabase
    .from('fidelidade_resgates')
    .select('campanha_id')
    .eq('usuario_id', usuarioId)
    .in('campanha_id', campanhas.map((c) => c.id));
  const usadas = new Set((resgates || []).map((r) => r.campanha_id));

  for (const campanha of campanhas) {
    if (usadas.has(campanha.id)) continue;
    if ((await contarAtendimentosNaAcao(usuarioId, campanha)) < campanha.cortes_necessarios) continue;
    return detalharPremio(campanha);
  }
  return null;
}

// Quanto o prêmio desconta neste atendimento. servicos: [{ id, valor, coberto }] (coberto = já
// sai de graça pela assinatura), produtos: [{ id, valor, quantidade }], subtotal: valor do
// atendimento inteiro antes do prêmio. Serviço/produto grátis só vale se estiver no atendimento;
// qualquer coisa a mais é cobrada normalmente. Desconto % ou R$ vale sobre o atendimento inteiro.
function calcularDescontoPremio(premio, { servicos = [], produtos = [], subtotal = 0 }) {
  if (!premio) return { aplicavel: false, desconto: 0, motivo: 'Este cliente não tem prêmio disponível.' };
  let desconto = 0;

  if (premio.tipo === 'servico') {
    const item = servicos.find((s) => Number(s.id) === Number(premio.servico.id));
    if (!item) return { aplicavel: false, desconto: 0, motivo: `A cortesia é ${premio.servico.nome}, que não está neste atendimento. Adicione o serviço pra aplicar.` };
    desconto = item.coberto ? 0 : Number(item.valor) || 0;
  } else if (premio.tipo === 'produto') {
    const item = produtos.find((p) => Number(p.id) === Number(premio.produto.id));
    if (!item) return { aplicavel: false, desconto: 0, motivo: `A cortesia é ${premio.produto.nome}, que não está neste atendimento. Adicione o produto pra aplicar.` };
    desconto = Number(item.valor) || 0; // uma unidade
  } else if (premio.tipo === 'desconto_percentual') {
    desconto = subtotal * (premio.valor / 100);
  } else if (premio.tipo === 'desconto_valor') {
    desconto = premio.valor;
  }

  return { aplicavel: true, desconto: arredondar(Math.min(Math.max(desconto, 0), subtotal)), motivo: null };
}

// Grava o uso do prêmio (chamado depois que o atendimento foi de fato fechado). O UNIQUE da tabela
// segura um segundo resgate da mesma ação mesmo sob corrida.
async function registrarResgatePremio({ empresaId, usuarioId, agendamentoId, premio, desconto }) {
  const { error } = await supabase.from('fidelidade_resgates').insert({
    empresa_id: empresaId,
    campanha_id: premio.campanha_id,
    usuario_id: usuarioId,
    agendamento_id: agendamentoId,
    tipo_premio: premio.tipo,
    valor_desconto: desconto
  });
  if (error) console.error('Erro ao registrar resgate de prêmio de fidelidade:', error);
}

module.exports = {
  verificarEDispararPremioFidelidade,
  notificarNovaCampanhaFidelidade,
  obterPremioDisponivel,
  calcularDescontoPremio,
  registrarResgatePremio
};
