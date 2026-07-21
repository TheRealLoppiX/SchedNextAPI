require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const verificarTokenAdmin = require('./src/middleware/adminAuth');
const iniciarLembretes = require('./src/cron/lembretes');
const iniciarProcessamentoCancelamentos = require('./src/cron/assinaturas');

const app = express();

// crossOriginResourcePolicy precisa ser "cross-origin": o front (porta 3000) e a API (porta 4000)
// são origens diferentes de propósito. Com o padrão do helmet ("same-origin"), o navegador
// bloqueia a leitura da resposta mesmo com os headers de CORS corretos.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));
app.use(cors({
  origin: process.env.FRONTEND_URL,
}));

// Protege toda a área /admin/*. O único endpoint sob /admin que fica de fora é o próprio
// /admin/login (é ele quem emite o token) — ver src/middleware/adminAuth.js.
app.use('/admin', verificarTokenAdmin);

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/perfil'));
app.use(require('./src/routes/barbeiros'));
app.use(require('./src/routes/servicos'));
app.use(require('./src/routes/agendamentos'));
app.use(require('./src/routes/estoque'));
app.use(require('./src/routes/fidelidade'));
app.use(require('./src/routes/assinaturas'));
app.use(require('./src/routes/empresa'));
app.use(require('./src/routes/empresasPublico'));
app.use(require('./src/routes/pagamentos'));
app.use(require('./src/routes/whatsapp'));
app.use(require('./src/routes/unidades'));
app.use(require('./src/routes/apiKeys'));
app.use(require('./src/routes/apiPublica'));
app.use(require('./src/routes/ia'));
app.use(require('./src/routes/clientes'));

iniciarLembretes();
iniciarProcessamentoCancelamentos();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando em http://localhost:${PORT}`));
