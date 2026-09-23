require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const verificarTokenAdmin = require('./src/middleware/adminAuth');
const verificarTokenSuperAdmin = require('./src/middleware/superAdminAuth');
const iniciarLembretes = require('./src/cron/lembretes');
const iniciarProcessamentoCancelamentos = require('./src/cron/assinaturas');
const iniciarRecuperacaoClientes = require('./src/cron/recuperacaoClientes');
const iniciarRenovacaoTokenMercadoPago = require('./src/cron/mercadoPago');
const iniciarCobrancaAssinaturas = require('./src/cron/cobrancaAssinaturas');
const iniciarCobrancaPlataforma = require('./src/cron/cobrancaPlataforma');
const iniciarTrialPlanos = require('./src/cron/trialPlanos');
const iniciarResumoProfissionais = require('./src/cron/resumoProfissionais');
const { bloquearTrialExpirado } = require('./src/middleware/trialAuth');

const app = express();

// O Render coloca a API atrás de um proxy reverso, que sempre define X-Forwarded-For.
// Sem isso, o Express ignora esse header (padrão de segurança) e o keyGenerator do
// express-rate-limit lança ERR_ERL_UNEXPECTED_X_FORWARDED_FOR ao tentar ler o IP —
// a exceção derruba a requisição antes de chegar na rota, então nenhuma rota protegida
// por rate limit (cadastro, login, código de verificação) funcionava em produção.
// "1" confia só no primeiro hop (o proxy do Render), não na cadeia inteira, pra não
// abrir brecha de spoofing de IP via header em quem chama a API diretamente.
// Cloudflare (CDN) agora fica na frente do Render: cliente -> Cloudflare -> proxy do Render ->
// API. São 2 hops confiáveis. Com 1, o req.ip virava o IP do Cloudflare, e o rate limit
// (cadastro, login, código) passava a contar todos os usuários juntos por borda do CDN, além
// de o antifraude gravar o IP errado. Configurável por TRUST_PROXY_HOPS caso a infra mude.
// Atenção: acesso direto ao domínio .onrender.com (sem passar pelo Cloudflare) deixa o IP
// forjável via X-Forwarded-For; ideal é o Render aceitar tráfego só do Cloudflare.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 2);

// crossOriginResourcePolicy precisa ser "cross-origin": o front (porta 3000) e a API (porta 4000)
// são origens diferentes de propósito. Com o padrão do helmet ("same-origin"), o navegador
// bloqueia a leitura da resposta mesmo com os headers de CORS corretos.
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));
// Além do FRONTEND_URL exato (cobre dev local e o valor configurado em produção),
// libera qualquer subdomínio de tenant (ex: minha-empresa.schednext.com.br) sobre HTTPS,
// já que cada empresa agora pode ter seu próprio subdomínio na plataforma.
const DOMINIO_RAIZ = 'schednext.com.br';
function origemPermitida(origin, callback) {
  if (!origin) return callback(null, true);
  if (origin === process.env.FRONTEND_URL) return callback(null, true);
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === 'https:' && (hostname === DOMINIO_RAIZ || hostname.endsWith(`.${DOMINIO_RAIZ}`))) {
      return callback(null, true);
    }
  } catch (_) {
    // origin malformado, cai no reject abaixo
  }
  return callback(new Error('Origem não permitida pelo CORS'));
}
app.use(cors({
  origin: origemPermitida,
}));

// Protege toda a área /admin/*. Ficam de fora /admin/login e o fluxo de recuperação de senha
// (quem ainda não tem token). Ver src/middleware/adminAuth.js.
app.use('/admin', verificarTokenAdmin);

// Teste grátis acabou: trava o painel até assinar (ver src/middleware/trialAuth.js).
app.use('/admin', bloquearTrialExpirado);

// Segunda camada, só pra admin de UMA unidade (req.unidadeId setado, ver adminAuth.js): por
// padrão, bloqueia qualquer rota /admin/* que não esteja explicitamente liberada aqui. Assim,
// uma rota nova de admin criada no futuro fica automaticamente fora do alcance de um admin de
// unidade, a menos que alguém adicione ela nesta lista de propósito — comportamento seguro por
// padrão em vez de precisar lembrar de checar req.unidadeId em cada rota nova.
const ROTAS_PERMITIDAS_ADMIN_UNIDADE = [
  '/admin/unidade/',
  '/admin/encaixe',
  '/admin/agendar-encaixe',
  '/admin/finalizar-encaixe-completo',
  '/admin/confirmar-agendamento',
  '/admin/cancelar-agendamento',
  '/admin/finalizar-servico-checkout',
  '/admin/agendamento-usuario/',
  '/admin/buscar-clientes'
];
app.use('/admin', (req, res, next) => {
  if (req.unidadeId && !ROTAS_PERMITIDAS_ADMIN_UNIDADE.some((p) => req.originalUrl.startsWith(p))) {
    return res.status(403).json({ error: 'Acesso restrito ao painel da sua unidade.' });
  }
  next();
});

// Conta separada do dono da plataforma (ver src/middleware/superAdminAuth.js) — nunca aceita
// token de admin de empresa, e vice-versa.
app.use('/super-admin', verificarTokenSuperAdmin);

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/superAdmin'));
app.use(require('./src/routes/superAdminPlataforma'));
app.use(require('./src/routes/superAdminPrecificacao'));
app.use(require('./src/routes/superAdminFinanceiro'));
app.use(require('./src/routes/chavesAtivacao'));
app.use(require('./src/routes/perfil'));
app.use(require('./src/routes/barbeiros'));
app.use(require('./src/routes/servicos'));
app.use(require('./src/routes/agendamentos'));
app.use(require('./src/routes/estoque'));
app.use(require('./src/routes/fidelidade'));
app.use(require('./src/routes/assinaturas'));
app.use(require('./src/routes/campanhasAssinatura'));
app.use(require('./src/routes/empresa'));
app.use(require('./src/routes/empresasPublico'));
app.use(require('./src/routes/pagamentos'));
app.use(require('./src/routes/whatsapp'));
app.use(require('./src/routes/whatsappInstancia'));
app.use(require('./src/routes/unidades'));
app.use(require('./src/routes/apiKeys'));
app.use(require('./src/routes/apiPublica'));
app.use(require('./src/routes/ia'));
app.use(require('./src/routes/clientes'));
app.use(require('./src/routes/relatorios'));
app.use(require('./src/routes/dominioCustomizado'));
app.use(require('./src/routes/financeiro'));
app.use(require('./src/routes/mercadopago'));
app.use(require('./src/routes/cobrancaAssinatura'));
app.use(require('./src/routes/suporte'));
app.use(require('./src/routes/superAdminSuporte'));

iniciarLembretes();
iniciarProcessamentoCancelamentos();
iniciarRecuperacaoClientes();
iniciarRenovacaoTokenMercadoPago();
iniciarCobrancaAssinaturas();
iniciarCobrancaPlataforma();
iniciarTrialPlanos();
iniciarResumoProfissionais();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
