const cron = require('node-cron');
const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');

const DIAS_AVISO_ANTECIPADO = 3;

function botaoAssinar() {
  const link = `${process.env.FRONTEND_URL}/admin/conta`;
  return `<p style="text-align: center; margin: 20px 0 4px;"><a href="${link}" style="display: inline-block; background: #2554eb; color: #fff; text-decoration: none; font-weight: 600; padding: 12px 24px; border-radius: 8px;">Escolher meu plano</a></p>`;
}

function emailTesteAcabando({ nome, diasRestantes }) {
  return {
    subject: `Seu teste grátis termina em ${diasRestantes} ${diasRestantes === 1 ? 'dia' : 'dias'} - SchedNext`,
    html: emailHtml({
      titulo: `Seu teste está acabando, ${nome}`,
      mensagemHtml: `
        <p style="margin: 0 0 8px;">Faltam <strong>${diasRestantes} ${diasRestantes === 1 ? 'dia' : 'dias'}</strong> para o fim do seu período de teste na SchedNext.</p>
        <p style="margin: 0;">Assine um plano agora para continuar recebendo agendamentos sem interrupção. Seus dados ficam todos guardados.</p>
        ${botaoAssinar()}
      `
    })
  };
}

function emailTesteAcabou({ nome }) {
  return {
    subject: 'Seu teste grátis acabou - assine para continuar - SchedNext',
    html: emailHtml({
      titulo: `Seu período de teste acabou, ${nome}`,
      mensagemHtml: `
        <p style="margin: 0 0 8px;">Esperamos que você tenha gostado da SchedNext! O acesso ao painel foi pausado até você escolher um plano.</p>
        <p style="margin: 0;">Seus clientes, serviços e histórico continuam guardados: é só assinar e tudo volta ao normal na hora.</p>
        ${botaoAssinar()}
      `
    })
  };
}

// Só considera "em teste" quem NÃO tem plano pago em dia, chave promocional ou teste de plano
// do admin absoluto em vigor (mesma regra do bloqueio, ver middleware/trialAuth.js).
function emTesteSemPlano(empresa, agora) {
  const emVigor = (v) => v && new Date(v).getTime() > agora;
  const planoPago = empresa.plano_plataforma && empresa.plano_plataforma.preco_mensal !== 0 && empresa.status_assinatura === 'ativa';
  return !planoPago && !emVigor(empresa.chave_ativacao_expira_em) && !emVigor(empresa.plano_teste_expira_em);
}

async function encerrarTestesDePlano() {
  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id, nome, plano_teste_anterior_id')
    .not('plano_teste_expira_em', 'is', null)
    .lte('plano_teste_expira_em', new Date().toISOString());

  if (error) return console.error('Erro ao buscar testes de plano expirados:', error);

  for (const empresa of empresas || []) {
    // Sem plano anterior guardado (não deveria acontecer) cai pro Grátis em vez de ficar preso.
    let destinoId = empresa.plano_teste_anterior_id;
    if (!destinoId) {
      const { data: gratis } = await supabase.from('planos_plataforma').select('id').eq('nome', 'Grátis').maybeSingle();
      destinoId = gratis?.id;
    }
    if (!destinoId) continue;

    const { error: updErr } = await supabase
      .from('empresas')
      .update({ plano_plataforma_id: destinoId, plano_teste_anterior_id: null, plano_teste_expira_em: null })
      .eq('id', empresa.id);

    if (updErr) console.error(`Erro ao encerrar teste de plano de ${empresa.nome}:`, updErr);
    else console.log(`${empresa.nome}: teste de plano encerrado, voltou ao plano anterior.`);
  }
}

async function avisarFimDoTeste() {
  const agora = Date.now();
  const limiteAviso = new Date(agora + DIAS_AVISO_ANTECIPADO * 86400000).toISOString();

  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id, nome, email, trial_expira_em, trial_aviso_enviado_em, trial_expirado_avisado_em, chave_ativacao_expira_em, plano_teste_expira_em, status_assinatura, plano_plataforma:plano_plataforma_id(preco_mensal)')
    .not('trial_expira_em', 'is', null)
    .lte('trial_expira_em', limiteAviso);

  if (error) return console.error('Erro ao buscar testes grátis perto do fim:', error);

  for (const empresa of empresas || []) {
    try {
      if (!emTesteSemPlano(empresa, agora)) continue;

      const expiraMs = new Date(empresa.trial_expira_em).getTime();
      if (expiraMs > agora) {
        if (empresa.trial_aviso_enviado_em) continue;
        const diasRestantes = Math.max(1, Math.ceil((expiraMs - agora) / 86400000));
        await transporter.sendMail({ to: empresa.email, ...emailTesteAcabando({ nome: empresa.nome, diasRestantes }) });
        await supabase.from('empresas').update({ trial_aviso_enviado_em: new Date().toISOString() }).eq('id', empresa.id);
        console.log(`${empresa.nome}: aviso de teste acabando enviado.`);
      } else {
        if (empresa.trial_expirado_avisado_em) continue;
        await transporter.sendMail({ to: empresa.email, ...emailTesteAcabou({ nome: empresa.nome }) });
        await supabase.from('empresas').update({ trial_expirado_avisado_em: new Date().toISOString() }).eq('id', empresa.id);
        console.log(`${empresa.nome}: aviso de teste expirado enviado.`);
      }
    } catch (err) {
      console.error(`Erro ao avisar fim de teste de ${empresa.nome}:`, err);
    }
  }
}

// Roda uma vez por dia: devolve empresas ao plano anterior quando o teste de plano do admin
// absoluto acaba e manda os e-mails de "seu teste está acabando" (3 dias antes) e "seu teste
// acabou" (no vencimento), cada um uma única vez por empresa.
function iniciarTrialPlanos() {
  cron.schedule('0 9 * * *', async () => {
    console.log('Processando testes de plano e fim de período de teste...');
    await encerrarTestesDePlano();
    await avisarFimDoTeste();
  });
}

module.exports = iniciarTrialPlanos;
