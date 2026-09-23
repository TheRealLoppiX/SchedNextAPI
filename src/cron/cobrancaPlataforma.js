const cron = require('node-cron');
const supabase = require('../config/supabase');
const { criarPixAssinaturaPlataforma } = require('../services/pagamento');
const { buscarCampanhaDaEmpresa, precoDoCiclo } = require('../services/precificacaoPlataforma');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');

// Cobrança recorrente da assinatura da PLATAFORMA (empresa pagando a SchedNext) via Pix — o
// cartão é cobrado sozinho pelo Mercado Pago (preapproval, ver routes/mercadopago.js:
// processarNotificacaoAssinatura), mas Pix não tem recorrência nativa lá, então cada ciclo
// precisa de uma cobrança avulsa nova gerada por aqui. Mesmo princípio de
// cron/cobrancaAssinaturas.js (cliente final pagando a própria empresa), só que pro lado da
// SchedNext, com o access_token da plataforma. O 1º ciclo nasce direto em
// POST /admin/assinatura-plataforma/iniciar-upgrade — este cron só cuida do 2º em diante.
function iniciarCobrancaPlataforma() {
  cron.schedule('0 6 * * *', async () => {
    console.log('Verificando cobrança recorrente da assinatura da plataforma (Pix)...');

    const hoje = new Date().toISOString().slice(0, 10);

    const { data: empresas, error } = await supabase
      .from('empresas')
      .select('id, nome, email, ciclo_cobranca_atual, campanha_precificacao_id, proxima_cobranca_em, plano_plataforma:plano_plataforma_id(nome, preco_mensal)')
      .eq('status_assinatura', 'ativa')
      .eq('plataforma_forma_pagamento', 'pix');

    if (error) return console.error('Erro ao buscar empresas com cobrança de plataforma via Pix:', error);

    for (const empresa of empresas || []) {
      try {
        // proxima_cobranca_em só é escrito quando o ciclo anterior é confirmado (ver
        // routes/mercadopago.js) — null aqui significa "ainda não pagou o 1º ciclo", que já
        // nasceu em iniciar-upgrade, não é responsabilidade deste cron.
        if (!empresa.proxima_cobranca_em) continue;
        if (empresa.proxima_cobranca_em.slice(0, 10) !== hoje) continue;
        if (!(Number(empresa.plano_plataforma?.preco_mensal) > 0)) continue;

        const proximoCiclo = empresa.ciclo_cobranca_atual || 1;

        const { data: existente } = await supabase
          .from('plataforma_cobrancas')
          .select('id')
          .eq('empresa_id', empresa.id)
          .eq('ciclo_ref', proximoCiclo)
          .maybeSingle();
        if (existente) continue;

        const campanha = await buscarCampanhaDaEmpresa(empresa.campanha_precificacao_id);
        const valor = precoDoCiclo(campanha, proximoCiclo, empresa.plano_plataforma?.preco_mensal ?? 0);

        const cobranca = await criarPixAssinaturaPlataforma({
          empresaId: empresa.id,
          planoNome: empresa.plano_plataforma?.nome || '',
          valor,
          email: empresa.email,
          cicloRef: proximoCiclo
        });
        if (!cobranca.configurado) continue;

        await supabase.from('plataforma_cobrancas').insert({
          empresa_id: empresa.id,
          ciclo_ref: proximoCiclo,
          valor,
          forma_pagamento: 'pix',
          mercadopago_payment_id: cobranca.mercadopagoPaymentId,
          status: 'pendente'
        });

        if (empresa.email) {
          transporter.sendMail({
            to: empresa.email,
            subject: 'Cobrança da sua assinatura SchedNext',
            html: emailHtml({
              titulo: `Olá, ${empresa.nome}!`,
              mensagemHtml: `
                <p style="margin: 0 0 4px;">Sua próxima cobrança da SchedNext (${empresa.plano_plataforma?.nome || 'seu plano'}) está pronta.</p>
                <p style="margin: 12px 0;">Pague o Pix direto na tela de Conta do seu painel administrativo.</p>
              `
            })
          }).catch((err) => console.error('Erro ao enviar e-mail de cobrança Pix da plataforma:', err));
        }

        console.log(`Cobrança Pix da assinatura da plataforma gerada pra empresa ${empresa.nome} (ciclo ${proximoCiclo}).`);
      } catch (err) {
        console.error(`Erro ao processar cobrança de plataforma da empresa ${empresa.id}:`, err);
      }
    }

    // Segunda passada: cobranças Pix pendentes há mais de 24h sem confirmar — marca
    // inadimplente, mesmo princípio do lado do cliente final em cron/cobrancaAssinaturas.js.
    const { data: pendentesVencidas, error: errVencidas } = await supabase
      .from('plataforma_cobrancas')
      .select('id, empresa_id')
      .eq('status', 'pendente')
      .eq('forma_pagamento', 'pix')
      .lt('criado_em', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (errVencidas) return console.error('Erro ao buscar cobranças de plataforma vencidas:', errVencidas);

    for (const cobranca of pendentesVencidas || []) {
      try {
        await supabase.from('plataforma_cobrancas').update({ status: 'inadimplente' }).eq('id', cobranca.id);
        await supabase.from('empresas').update({ status_assinatura: 'inadimplente' }).eq('id', cobranca.empresa_id);
      } catch (err) {
        console.error(`Erro ao marcar cobrança de plataforma vencida ${cobranca.id}:`, err);
      }
    }
  });
}

module.exports = iniciarCobrancaPlataforma;
