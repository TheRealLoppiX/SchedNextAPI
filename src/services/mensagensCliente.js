const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const { enviarMensagem } = require('./whatsapp/provider');

// Conteúdo compartilhado entre o disparo manual (routes/clientes.js) e o automático
// (cron/recuperacaoClientes.js), pra não ter o mesmo texto duplicado em dois lugares.

function construirMensagemSaudade({ primeiroNome, nomeEmpresa }) {
  return {
    assunto: `${nomeEmpresa} sente sua falta, ${primeiroNome}!`,
    textoWhats: `Oi ${primeiroNome}! Faz um tempo que você não aparece na ${nomeEmpresa} e sentimos a sua falta. Que tal agendar um horário? Estamos te esperando!`,
    html: emailHtml({
      titulo: `Olá, ${primeiroNome}!`,
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Faz um tempo que você não aparece por aqui e sentimos a sua falta!</p>
        <p style="margin: 12px 0;">Que tal agendar um horário? Estamos te esperando.</p>
      `
    })
  };
}

function construirMensagemAniversario({ primeiroNome, nomeEmpresa }) {
  return {
    assunto: `Feliz Aniversário, ${primeiroNome}!`,
    textoWhats: `Feliz Aniversário, ${primeiroNome}! A equipe da ${nomeEmpresa} veio te desejar tudo de melhor! Que tal comemorar com um visual novo?`,
    html: emailHtml({
      titulo: `Feliz Aniversário, ${primeiroNome}!`,
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Hoje é o seu dia especial e a equipe da <strong>${nomeEmpresa}</strong> veio te desejar tudo de melhor!</p>
        <p style="margin: 12px 0;">Você merece se sentir incrível hoje. Que tal comemorar com um visual novo?</p>
      `
    })
  };
}

// `canais`: { email: bool, whatsapp: bool }. Cada canal só é usado se o dado necessário existir
// (email/telefone do cliente) — pedir um canal sem o dado correspondente é simplesmente ignorado,
// não vira erro (evita travar o disparo de um cliente só porque ele não tem telefone cadastrado).
async function enviarMensagemCliente({ tipo, cliente, nomeEmpresa, canais, instancia }) {
  const primeiroNome = (cliente.nome_completo || '').split(' ')[0] || 'Cliente';
  const construtor = tipo === 'aniversario' ? construirMensagemAniversario : construirMensagemSaudade;
  const { assunto, textoWhats, html } = construtor({ primeiroNome, nomeEmpresa });

  const resultado = { email: false, whatsapp: false };

  if (canais?.email && cliente.email) {
    await transporter.sendMail({ to: cliente.email, subject: assunto, html });
    resultado.email = true;
  }

  if (canais?.whatsapp && cliente.telefone) {
    // usuarios.telefone é salvo sem DDI (ver utils/telefone.js), Evolution API espera com 55.
    await enviarMensagem(instancia, `55${cliente.telefone.replace(/\D/g, '')}`, textoWhats);
    resultado.whatsapp = true;
  }

  return resultado;
}

module.exports = { enviarMensagemCliente };
