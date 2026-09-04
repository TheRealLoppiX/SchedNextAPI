const cron = require('node-cron');
const supabase = require('../config/supabase');
const { calcularInicioCiclo } = require('../utils/limitesAssinatura');
const {
  gerarCobrancaPix,
  enviarNotificacaoCobrancaPix,
  verificarCobrancaCartao,
  marcarInadimplente
} = require('../services/cobrancaAssinatura');

// Roda uma vez por dia: cobrança recorrente da assinatura do CLIENTE FINAL (mensalidade que ele
// paga pra própria barbearia). Só considera quem tem assinatura_forma_pagamento configurada —
// assinante vinculado pelo admin sem cobrança automática (o caso comum de primeira mensalidade
// paga presencialmente) fica de fora por design, sem tentativa de cobrança nem inadimplência
// automática. Mesmo padrão de "uma query, loop com try/catch por linha, não propaga erro" já
// usado em cron/assinaturas.js e cron/mercadoPago.js.
function iniciarCobrancaAssinaturas() {
  cron.schedule('0 5 * * *', async () => {
    console.log('Verificando cobrança recorrente de assinaturas de clientes...');

    const hoje = new Date().toISOString().slice(0, 10);

    const { data: assinantes, error } = await supabase
      .from('usuarios')
      .select('id, empresa_id, plano_id, nome_completo, email, telefone, assinante_desde, assinatura_forma_pagamento, status_assinatura, mercadopago_preapproval_id')
      .eq('assinante', true)
      .not('plano_id', 'is', null)
      .not('assinatura_forma_pagamento', 'is', null);

    if (error) return console.error('Erro ao buscar assinantes pra cobrança recorrente:', error);

    for (const usuario of assinantes || []) {
      try {
        if (!usuario.assinante_desde) continue;
        const cicloRef = calcularInicioCiclo(usuario.assinante_desde);
        if (cicloRef !== hoje) continue;

        const { data: existente } = await supabase
          .from('assinatura_cobrancas')
          .select('id')
          .eq('usuario_id', usuario.id)
          .eq('ciclo_ref', cicloRef)
          .maybeSingle();
        if (existente) continue;

        const { data: empresa } = await supabase
          .from('empresas')
          .select('id, nome, mercadopago_access_token, whatsapp_phone_number_id')
          .eq('id', usuario.empresa_id)
          .maybeSingle();
        const { data: plano } = await supabase
          .from('planos_assinatura')
          .select('id, nome, preco')
          .eq('id', usuario.plano_id)
          .maybeSingle();
        if (!empresa || !plano) continue;

        if (usuario.assinatura_forma_pagamento === 'pix') {
          if (!empresa.mercadopago_access_token) continue;
          const { qr_code, qr_code_base64 } = await gerarCobrancaPix({ usuario, empresa, plano });
          await enviarNotificacaoCobrancaPix({ usuario, empresa, plano, qrCode: qr_code, qrCodeBase64: qr_code_base64 });
          console.log(`Cobrança Pix da mensalidade gerada e enviada pra ${usuario.nome_completo}.`);
        } else if (usuario.assinatura_forma_pagamento === 'cartao') {
          // O Mercado Pago cobra sozinho no preapproval já agendado — aqui só abre o registro
          // do ciclo, que a segunda passada abaixo confirma como paga (ou não) no dia seguinte.
          await supabase.from('assinatura_cobrancas').insert({
            usuario_id: usuario.id,
            empresa_id: empresa.id,
            plano_id: plano.id,
            ciclo_ref: cicloRef,
            valor: plano.preco,
            forma_pagamento: 'cartao',
            status: 'pendente'
          });
        }
      } catch (err) {
        console.error(`Erro ao processar cobrança recorrente do cliente ${usuario.id}:`, err);
      }
    }

    // Segunda passada: cobranças pendentes cujo ciclo já venceu (ontem ou antes) — confirma
    // cartão por polling (buscarPreapproval, já que não há webhook confiável por ciclo pra
    // assinatura de cliente final) e marca Pix não pago como inadimplente.
    const { data: pendentesVencidas, error: errVencidas } = await supabase
      .from('assinatura_cobrancas')
      .select('id, usuario_id, empresa_id, forma_pagamento, ciclo_ref')
      .eq('status', 'pendente')
      .lt('ciclo_ref', hoje);

    if (errVencidas) return console.error('Erro ao buscar cobranças vencidas:', errVencidas);

    for (const cobranca of pendentesVencidas || []) {
      try {
        const { data: usuario } = await supabase
          .from('usuarios')
          .select('id, nome_completo, email, telefone, status_assinatura, mercadopago_preapproval_id')
          .eq('id', cobranca.usuario_id)
          .maybeSingle();
        if (!usuario) continue;

        if (cobranca.forma_pagamento === 'pix') {
          const { data: empresa } = await supabase
            .from('empresas')
            .select('id, nome, whatsapp_phone_number_id')
            .eq('id', cobranca.empresa_id)
            .maybeSingle();
          await marcarInadimplente(usuario, empresa);
          continue;
        }

        if (cobranca.forma_pagamento === 'cartao') {
          const { data: empresa } = await supabase
            .from('empresas')
            .select('id, nome, mercadopago_access_token, whatsapp_phone_number_id')
            .eq('id', cobranca.empresa_id)
            .maybeSingle();
          const status = await verificarCobrancaCartao({ usuario, empresa });
          if (status === 'authorized') {
            await supabase.from('assinatura_cobrancas').update({ status: 'pago', pago_em: new Date().toISOString() }).eq('id', cobranca.id);
          } else {
            await supabase.from('assinatura_cobrancas').update({ status: 'falhou' }).eq('id', cobranca.id);
            await marcarInadimplente(usuario, empresa);
          }
        }
      } catch (err) {
        console.error(`Erro ao confirmar cobrança vencida ${cobranca.id}:`, err);
      }
    }
  });
}

module.exports = iniciarCobrancaAssinaturas;
