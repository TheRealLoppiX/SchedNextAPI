const cron = require('node-cron');
const { processarFila } = require('../services/prospeccao');

// Roda a cada minuto, mas manda no máximo uma mensagem por vez: limite diário, dias/horários
// e o intervalo aleatório entre envios ficam todos na config do admin absoluto
// (ver services/prospeccao.js).
function iniciarProspeccao() {
  cron.schedule('*/1 * * * *', () => {
    processarFila().catch((err) => console.error('Erro no cron de prospecção:', err));
  });
}

module.exports = iniciarProspeccao;
