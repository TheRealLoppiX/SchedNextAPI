// Flags de manutenção/disponibilidade de features, independentes do plano da empresa (ver
// utils/limitesPlano.js pra gates por plano) — usado quando a plataforma inteira precisa
// desligar temporariamente algo, sem mexer em cada empresa uma por uma.

// Modo livre do bot de WhatsApp (IA conduzindo a conversa via tool calling, ver
// services/whatsapp/agente.js) desligado a pedido — 2026-09-25. O modo guiado continua normal.
// Empresas que já tinham 'livre' salvo como preferência mantêm o valor salvo (não perdem a
// escolha), mas o bot roda em guiado até essa flag voltar pra true (ver
// services/whatsapp/bot.js e routes/whatsappInstancia.js).
const MODO_LIVRE_BOT_DISPONIVEL = false;

// Nome, personalidade e criatividade do assistente (reescrita de tom por IA em cima das mensagens
// do modo guiado, ver aplicarPersonalidade em services/whatsapp/bot.js) desligados a pedido —
// 2026-09-27, junto com o modo livre. Valores salvos são mantidos e voltam a valer quando a flag
// voltar pra true; enquanto isso o bot responde com os textos fixos e a rota de config não
// sobrescreve esses campos.
const PERSONALIDADE_BOT_DISPONIVEL = false;

module.exports = { MODO_LIVRE_BOT_DISPONIVEL, PERSONALIDADE_BOT_DISPONIVEL };
