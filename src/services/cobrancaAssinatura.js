const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('./whatsapp/provider');
const { obterTaxaMarketplace, permiteWhatsappBot } = require('../utils/limitesPlano');
const { calcularInicioCiclo } = require('../utils/limitesAssinatura');
const { criarPagamentoPix, buscarPreapproval } = require('./mercadopago');

// Núcleo da cobrança recorrente de ASSINATURA DO CLIENTE FINAL (mensalidade que ele paga pra
// própria barbearia — não confundir com a assinatura da plataforma SchedNext, ver
// services/pagamento.js). Reaproveitado pelo cron diário (cron/cobrancaAssinaturas.js), pelos
// endpoints de admin (routes/cobrancaAssinatura.js) e pelo endpoint do cliente
// (routes/mercadopago.js). Mercado Pago não tem Pix recorrente — cada ciclo gera uma cobrança
// Pix avulsa nova, igual ao Pix do PDV (services/mercadopago.js:criarPagamentoPix), só que pro
// valor do plano em vez do atendimento.

// Acha a linha de assinatura_cobrancas do ciclo atual do cliente, criando (status 'pendente')
// se ainda não existir — usado tanto pra registrar uma cobrança nova (Pix/cartão) quanto pra
// dar baixa manual em cliente que nunca teve cobrança automática configurada (o caso comum de
// primeira mensalidade paga presencialmente, sem nenhuma linha ainda).
async function obterOuCriarCobrancaCicloAtual({ usuario, empresa, plano, formaPagamento }) {
  const cicloRef = calcularInicioCiclo(usuario.assinante_desde);

  const { data: existente, error: errBusca } = await supabase
    .from('assinatura_cobrancas')
    .select('id, status, forma_pagamento')
    .eq('usuario_id', usuario.id)
    .eq('ciclo_ref', cicloRef)
    .maybeSingle();
  if (errBusca) throw errBusca;
  if (existente) return existente;

  const { data: nova, error: errInsert } = await supabase
    .from('assinatura_cobrancas')
    .insert({
      usuario_id: usuario.id,
      empresa_id: empresa.id,
      plano_id: plano.id,
      ciclo_ref: cicloRef,
      valor: plano.preco,
      forma_pagamento: formaPagamento,
      status: 'pendente'
    })
    .select('id, status, forma_pagamento')
    .single();
  if (errInsert) throw errInsert;
  return nova;
}

// Gera uma cobrança Pix nova pro ciclo atual (upsert em cima de UNIQUE(usuario_id, ciclo_ref) —
// idempotente, então gerar de novo no mesmo ciclo — ex: cliente perdeu o QR — devolve/atualiza a
// mesma linha em vez de duplicar). applicationFee usa a mesma taxa de marketplace do Pix avulso
// e do preapproval (obterTaxaMarketplace).
async function gerarCobrancaPix({ usuario, empresa, plano }) {
  const cicloRef = calcularInicioCiclo(usuario.assinante_desde);
  const taxaPercentual = await obterTaxaMarketplace(empresa.id);

  const cobranca = await criarPagamentoPix({
    accessTokenVendedor: empresa.mercadopago_access_token,
    valor: plano.preco,
    descricao: `${empresa.nome} — assinatura ${plano.nome}`,
    externalReference: `assinatura-${usuario.id}-${cicloRef}`,
    payerEmail: usuario.email,
    applicationFee: plano.preco * (taxaPercentual / 100)
  });

  const { data: linha, error } = await supabase
    .from('assinatura_cobrancas')
    .upsert({
      usuario_id: usuario.id,
      empresa_id: empresa.id,
      plano_id: plano.id,
      ciclo_ref: cicloRef,
      valor: plano.preco,
      forma_pagamento: 'pix',
      status: 'pendente',
      mercadopago_payment_id: String(cobranca.id)
    }, { onConflict: 'usuario_id,ciclo_ref' })
    .select('id')
    .single();
  if (error) throw error;

  return {
    cobranca_id: linha.id,
    qr_code: cobranca.point_of_interaction?.transaction_data?.qr_code || null,
    qr_code_base64: cobranca.point_of_interaction?.transaction_data?.qr_code_base64 || null
  };
}

// Manda o Pix da mensalidade por e-mail (QR embutido como imagem + código copia-e-cola) e
// WhatsApp (só o código copia-e-cola em texto — o adapter da Evolution API não manda imagem, ver
// services/whatsapp/provider.js). Mesmo padrão de notificarPagamentoConfirmado em
// routes/mercadopago.js.
async function enviarNotificacaoCobrancaPix({ usuario, empresa, plano, qrCode, qrCodeBase64 }) {
  if (usuario.email) {
    transporter.sendMail({
      to: usuario.email,
      subject: `Mensalidade do plano ${plano.nome} - ${empresa.nome}`,
      html: emailHtml({
        titulo: `Olá, ${usuario.nome_completo}!`,
        mensagemHtml: `
          <p style="margin: 0 0 12px;">Sua mensalidade do plano <strong>${plano.nome}</strong> na <strong>${empresa.nome}</strong> está disponível pra pagamento via Pix.</p>
          <p style="margin: 12px 0; font-size: 15px;"><strong>Valor:</strong> R$ ${Number(plano.preco).toFixed(2)}</p>
          ${qrCodeBase64 ? `<img src="data:image/png;base64,${qrCodeBase64}" alt="QR Code Pix" style="display:block;margin:16px auto;max-width:220px;" />` : ''}
          ${qrCode ? `<p style="margin: 12px 0; font-size: 12px; word-break: break-all; background:#fff; border:1px solid #e2e5f0; border-radius:8px; padding:12px;">${qrCode}</p>` : ''}
        `
      })
    }).catch((err) => console.error('Erro ao enviar e-mail de cobrança de assinatura:', err));
  }

  if (usuario.telefone && qrCode && (await permiteWhatsappBot(empresa.id))) {
    enviarMensagem(
      empresa.whatsapp_phone_number_id,
      `55${usuario.telefone.replace(/\D/g, '')}`,
      `💈 Mensalidade do plano ${plano.nome} na ${empresa.nome}: R$ ${Number(plano.preco).toFixed(2)}.\n\nPix copia e cola:\n${qrCode}`
    ).catch((err) => console.error('Erro ao enviar WhatsApp de cobrança de assinatura:', err));
  }
}

// Confirma o status do preapproval de cartão do cliente. Não existe webhook confiável por ciclo
// pra assinatura de cliente final (ver comentário em routes/mercadopago.js sobre
// subscription_authorized_payment não escalar pra várias empresas conectadas) — a confirmação é
// por polling, feita pelo cron 1 dia depois do vencimento do ciclo.
async function verificarCobrancaCartao({ usuario, empresa }) {
  if (!usuario.mercadopago_preapproval_id || !empresa?.mercadopago_access_token) return null;
  const preapproval = await buscarPreapproval({
    accessToken: empresa.mercadopago_access_token,
    preapprovalId: usuario.mercadopago_preapproval_id
  });
  return preapproval.status;
}

// Confirma no ledger que a cobrança de cartão do ciclo atual do cliente caiu — chamado tanto
// pelo webhook de subscription_preapproval (routes/mercadopago.js, quando o MP avisa que o
// preapproval está 'authorized') quanto pelo polling do cron do dia seguinte ao vencimento. Não
// falha se a linha do ciclo ainda não existir (ex: webhook chegou antes do cron abrir o
// registro do dia) — nesse caso não há o que confirmar ainda, o cron cria e já encontra a
// próxima confirmação depois.
async function confirmarCicloCartao(usuario) {
  if (!usuario.assinante_desde) return;
  const cicloRef = calcularInicioCiclo(usuario.assinante_desde);

  const { data: linha } = await supabase
    .from('assinatura_cobrancas')
    .select('id, status')
    .eq('usuario_id', usuario.id)
    .eq('ciclo_ref', cicloRef)
    .maybeSingle();

  if (linha && linha.status === 'pendente') {
    await supabase.from('assinatura_cobrancas').update({ status: 'pago', pago_em: new Date().toISOString() }).eq('id', linha.id);
  }
}

// Suspende o benefício do plano (preço/cota — ver utils/limitesAssinatura.js) sem mexer no
// vínculo do plano em si (assinante/plano_id continuam intactos). Guard de transição (só avisa
// quando MUDA pra inadimplente) evita reenviar o aviso a cada rodada do cron enquanto o cliente
// continuar em atraso — mesmo padrão do aviso de assinatura da plataforma em
// processarNotificacaoAssinatura (routes/mercadopago.js).
async function marcarInadimplente(usuario, empresa) {
  if (usuario.status_assinatura === 'inadimplente') return;

  await supabase.from('usuarios').update({ status_assinatura: 'inadimplente' }).eq('id', usuario.id);

  if (usuario.email) {
    transporter.sendMail({
      to: usuario.email,
      subject: `Mensalidade em atraso - ${empresa?.nome || 'SchedNext'}`,
      html: emailHtml({
        titulo: `Olá, ${usuario.nome_completo}!`,
        mensagemHtml: `
          <p style="margin: 0 0 4px;">Não identificamos o pagamento da sua mensalidade na <strong>${empresa?.nome || 'barbearia'}</strong>.</p>
          <p style="margin: 12px 0;">Enquanto isso, os benefícios do seu plano ficam suspensos (preço e cota de assinante). Regularize o pagamento para voltar a ter acesso a eles.</p>
        `
      })
    }).catch((err) => console.error('Erro ao enviar e-mail de inadimplência:', err));
  }

  if (usuario.telefone && empresa?.whatsapp_phone_number_id && (await permiteWhatsappBot(empresa.id))) {
    enviarMensagem(
      empresa.whatsapp_phone_number_id,
      `55${usuario.telefone.replace(/\D/g, '')}`,
      `⚠️ Não identificamos o pagamento da sua mensalidade na ${empresa?.nome || 'barbearia'}. Os benefícios do seu plano ficam suspensos até regularizar.`
    ).catch((err) => console.error('Erro ao enviar WhatsApp de inadimplência:', err));
  }
}

// Restaura o benefício do plano assim que a mensalidade é confirmada (automática ou baixa
// manual). Não reenvia notificação de "voltou a ficar em dia" — o recibo de pagamento (quando
// houver, ex: webhook do Pix) já cobre esse aviso.
async function marcarEmDia(usuarioId) {
  await supabase.from('usuarios').update({ status_assinatura: 'em_dia' }).eq('id', usuarioId);
}

module.exports = {
  obterOuCriarCobrancaCicloAtual,
  gerarCobrancaPix,
  enviarNotificacaoCobrancaPix,
  verificarCobrancaCartao,
  confirmarCicloCartao,
  marcarInadimplente,
  marcarEmDia
};
