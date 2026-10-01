const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { criarPixAssinaturaPlataforma } = require('./pagamento');
const { buscarCampanhaParaNovoCadastro, precoDoCiclo } = require('./precificacaoPlataforma');
const { enviarWhatsappPlataforma } = require('./whatsappPlataforma');

// Todo plano pago é pago: quando o admin absoluto põe uma empresa num plano pago (troca manual,
// plano exclusivo, Enterprise), a empresa é cobrada e o plano só vale depois do pagamento, igual
// à troca que ela mesma faz pela Conta (POST /admin/assinatura-plataforma/iniciar-upgrade). As
// únicas cortesias são o teste grátis do plano, a chave de ativação e o "Testar planos".
//
// A cobrança é um Pix do 1º ciclo (com a campanha do plano, se houver) numa série nova (ver
// sql/2026_cobranca_obrigatoria_plataforma.sql). O plano fica pendente; o webhook do Mercado
// Pago aplica quando o Pix cair (routes/mercadopago.js). Se a empresa preferir cartão, paga pela
// tela Conta, que mostra a cobrança pendente. Aviso por e-mail, WhatsApp da plataforma e no painel.

// Campanha que vale pra quem contrata o plano agora. Plano exclusivo: a campanha própria dele
// (sempre em vigor); plano público: a campanha em vigor no momento.
async function campanhaDoPlano(plano) {
  if (plano.empresa_exclusiva_id) {
    const { data } = await supabase
      .from('campanhas_precificacao')
      .select('id, nome, campanha_precos_ciclo(numero_ciclo, valor)')
      .eq('plano_plataforma_id', plano.id)
      .eq('ativa', true)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data || null;
  }
  return buscarCampanhaParaNovoCadastro(plano.id);
}

const formatarReal = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
const linkConta = () => `${(process.env.FRONTEND_URL || 'https://schednext.com.br').replace(/\/$/, '')}/admin/conta`;

async function cobrarPlanoDaEmpresa({ empresaId, planoId }) {
  const { data: empresa } = await supabase.from('empresas').select('id, nome, email, telefone, plataforma_serie').eq('id', empresaId).maybeSingle();
  if (!empresa) throw Object.assign(new Error('Empresa não encontrada.'), { status: 404 });
  const { data: plano } = await supabase.from('planos_plataforma').select('id, nome, preco_mensal, empresa_exclusiva_id').eq('id', planoId).maybeSingle();
  if (!plano) throw Object.assign(new Error('Plano inválido.'), { status: 400 });
  if (!(Number(plano.preco_mensal) > 0)) throw Object.assign(new Error('Só dá pra cobrar plano com preço definido.'), { status: 400 });

  const campanha = await campanhaDoPlano(plano);
  const valor = precoDoCiclo(campanha, 1, plano.preco_mensal);
  const serie = (empresa.plataforma_serie || 0) + 1;

  const pix = await criarPixAssinaturaPlataforma({ empresaId: empresa.id, planoNome: plano.nome, valor, email: empresa.email, cicloRef: 1 });
  if (!pix.configurado) throw Object.assign(new Error(pix.message), { status: 503 });

  // Cobrança de contratação anterior ainda em aberto deixa de valer (só a mais recente ativa plano).
  await supabase.from('plataforma_cobrancas')
    .update({ status: 'cancelada' })
    .eq('empresa_id', empresa.id)
    .eq('status', 'pendente')
    .eq('ciclo_ref', 1)
    .gt('serie', empresa.plataforma_serie || 0);

  const { error: errCobranca } = await supabase.from('plataforma_cobrancas').upsert({
    empresa_id: empresa.id,
    serie,
    ciclo_ref: 1,
    valor,
    forma_pagamento: 'pix',
    mercadopago_payment_id: pix.mercadopagoPaymentId,
    status: 'pendente',
    plano_plataforma_id: plano.id,
    campanha_precificacao_id: campanha?.id || null,
    origem: 'admin'
  }, { onConflict: 'empresa_id,serie,ciclo_ref' });
  if (errCobranca) throw errCobranca;

  // Plano atual continua valendo até o pagamento (e a recorrência dele também: o webhook cancela
  // a antiga quando o Pix novo cair).
  await supabase.from('empresas').update({ plano_plataforma_pendente_id: plano.id }).eq('id', empresa.id);

  const descricaoValor = campanha && Number(valor) !== Number(plano.preco_mensal)
    ? `${formatarReal(valor)} no 1º mês (depois ${formatarReal(plano.preco_mensal)}/mês)`
    : `${formatarReal(valor)}/mês`;

  const envios = { email: false, whatsapp: false };
  if (empresa.email) {
    try {
      await transporter.sendMail({
        to: empresa.email,
        subject: `Seu plano ${plano.nome} na SchedNext - pagamento pendente`,
        html: emailHtml({
          titulo: `Olá, ${empresa.nome}!`,
          mensagemHtml: `
            <p style="margin: 0 0 4px;">Seu plano <strong>${plano.nome}</strong> na SchedNext está pronto: ${descricaoValor}.</p>
            <p style="margin: 12px 0;">Ele passa a valer assim que o pagamento for confirmado. Pague pelo Pix copia e cola abaixo, ou com cartão pela tela Conta do seu painel:</p>
            <p style="margin: 12px 0; padding: 12px; background: #f4f4f5; border-radius: 8px; font-family: monospace; font-size: 12px; word-break: break-all;">${pix.qr_code || ''}</p>
            <p style="margin: 12px 0;"><a href="${linkConta()}">Abrir a tela Conta</a></p>
          `
        })
      });
      envios.email = true;
    } catch (err) {
      console.error('Erro ao enviar e-mail de cobrança de plano:', err);
    }
  }

  envios.whatsapp = await enviarWhatsappPlataforma(
    empresa.telefone,
    `Olá, ${empresa.nome}! Seu plano ${plano.nome} na SchedNext está pronto: ${descricaoValor}. Ele passa a valer assim que o pagamento for confirmado.\n\nPix copia e cola:\n${pix.qr_code || ''}\n\nOu pague com cartão pela tela Conta do painel: ${linkConta()}`
  );

  return { valor, envios };
}

module.exports = { cobrarPlanoDaEmpresa, campanhaDoPlano };
