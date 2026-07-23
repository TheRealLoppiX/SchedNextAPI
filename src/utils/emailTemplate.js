// Casca visual compartilhada por todos os e-mails transacionais do sistema, pra manter
// a marca (SchedNext) e o visual consistentes em vez de cada rota montar seu próprio HTML.
function emailHtml({ titulo, mensagemHtml }) {
  return `
    <div style="font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a2e;">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 20px; font-weight: 700; color: #2554eb;">SchedNext</span>
      </div>
      <div style="background: #f7f8fc; border-radius: 12px; padding: 28px 24px;">
        <h2 style="margin: 0 0 16px; font-size: 18px; color: #1a1a2e;">${titulo}</h2>
        ${mensagemHtml}
      </div>
      <p style="text-align: center; color: #8a8fa3; font-size: 12px; margin-top: 20px;">
        SchedNext — plataforma de agendamento online
      </p>
    </div>
  `;
}

function blocoCodigo(codigo) {
  return `<div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center; background: #fff; border: 1px solid #e2e5f0; border-radius: 8px; padding: 16px; margin: 16px 0; color: #2554eb;">${codigo}</div>`;
}

module.exports = { emailHtml, blocoCodigo };
