const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const validate = require('../middleware/validate');
const { cadastroEmpresaLimiter, codigoLimiter } = require('../middleware/rateLimiters');
const { registrarEmpresaSchema, contatoEnterpriseSchema, confirmarCodigoSchema } = require('../schemas');
const { registrarLead } = require('../services/leadsEnterprise');
const { emailHtml, blocoCodigo } = require('../utils/emailTemplate');
const { criarPendente, buscarPendenteValido, removerPendente } = require('../services/cadastroPendente');

const router = express.Router();

// Versão pública do contato Enterprise (ver também /admin/empresa/contato-enterprise em
// routes/empresa.js), pra quem ainda não tem conta e clica em Enterprise direto no cadastro.
// Reaproveita o limiter de cadastro só pra não virar vetor de spam do formulário.
router.post('/empresas/contato-enterprise', cadastroEmpresaLimiter, validate(contatoEnterpriseSchema), async (req, res) => {
  const { error } = await registrarLead({ empresaId: null, dados: req.body });
  if (error) return res.status(500).json({ error: 'Erro ao registrar seu contato. Tente novamente.' });
  res.json({ success: true, message: 'Recebemos seu contato! Nosso time entra em contato em breve.' });
});

// Planos da plataforma (não confundir com planos_assinatura, que é o plano de
// fidelidade que o negócio vende pro cliente dele). Usado pela landing e pelo
// passo de escolha de plano do cadastro self-service.
router.get('/planos-plataforma', async (req, res) => {
  const { data, error } = await supabase
    .from('planos_plataforma')
    .select('*')
    .order('id');

  if (error) return res.status(500).json(error);
  res.json(data);
});

router.get('/empresas/slug-disponivel/:slug', async (req, res) => {
  const slug = (req.params.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) {
    return res.json({ disponivel: false, motivo: 'Use apenas letras minúsculas, números e hífen (mín. 3 caracteres).' });
  }

  const { data, error } = await supabase.from('empresas').select('id').eq('slug', slug).maybeSingle();
  if (error) return res.status(500).json({ disponivel: false, motivo: 'Erro ao checar disponibilidade.' });

  res.json({ disponivel: !data });
});

router.post('/empresas/registrar', cadastroEmpresaLimiter, validate(registrarEmpresaSchema), async (req, res) => {
  const { nome, slug, email, senha, vertical, plano_plataforma_id } = req.body;

  const { data: slugExistente } = await supabase.from('empresas').select('id').eq('slug', slug).maybeSingle();
  if (slugExistente) return res.status(400).json({ error: 'Esse endereço já está em uso. Escolha outro.' });

  const { data: emailExistente } = await supabase.from('empresas').select('id').eq('email', email).maybeSingle();
  if (emailExistente) return res.status(400).json({ error: 'Já existe uma empresa cadastrada com esse e-mail.' });

  const { data: planoGratis } = await supabase.from('planos_plataforma').select('id').eq('nome', 'Grátis').maybeSingle();
  if (!planoGratis) return res.status(500).json({ error: 'Erro interno ao localizar o plano Grátis.' });
  let planoEscolhidoId = plano_plataforma_id || planoGratis.id;

  const { data: plano } = await supabase.from('planos_plataforma').select('id, nome, preco_mensal').eq('id', planoEscolhidoId).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  // Enterprise (e qualquer plano futuro "sob consulta") não tem preço fixo — não dá pra
  // assinar sozinho pelo cadastro, precisa passar pelo formulário de contato
  // (POST /empresas/contato-enterprise), igual em iniciar-upgrade (routes/pagamentos.js).
  if (plano.preco_mensal === null) {
    return res.status(400).json({ error: 'O plano Enterprise não tem valor fixo. Preencha o formulário de contato para negociar com nosso time.' });
  }

  const ehPago = plano.preco_mensal > 0;
  // A conta sempre nasce no Grátis, que é real e ativa na hora. Um plano pago escolhido aqui
  // vira o "plano pendente" — só é aplicado de verdade (POST /webhooks/mercadopago, ver
  // routes/mercadopago.js) quando o pagamento for confirmado. Sem isso, dava pra criar conta nova e ganhar qualquer
  // plano pago de graça, sem nunca pagar (ver handoff.md).
  const planoAplicadoId = ehPago ? planoGratis.id : plano.id;
  const planoPendenteId = ehPago ? plano.id : null;
  const senhaHash = await bcrypt.hash(senha, 12);
  const codigoVerificacao = Math.floor(100000 + Math.random() * 900000).toString();

  // Nada vai pra tabela `empresas` ainda — fica em espera em `cadastros_pendentes` até o
  // código ser confirmado em /empresas/confirmar-codigo (mesmo padrão do cadastro de
  // cliente, ver routes/auth.js e services/cadastroPendente.js).
  const { error } = await criarPendente({
    tipo: 'empresa',
    email,
    codigo: codigoVerificacao,
    dados: {
      nome,
      slug,
      senha: senhaHash,
      vertical,
      plano_plataforma_id: planoAplicadoId,
      plano_plataforma_pendente_id: planoPendenteId,
      plano_nome: plano.nome,
      status_assinatura: 'ativa',
      horarios_funcionamento: JSON.stringify({
        0: { aberto: false, abre: '08:00', fecha: '18:00', label: 'Domingo' },
        1: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Segunda-feira' },
        2: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Terça-feira' },
        3: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Quarta-feira' },
        4: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Quinta-feira' },
        5: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Sexta-feira' },
        6: { aberto: true, abre: '08:00', fecha: '18:00', label: 'Sábado' }
      })
    }
  });

  if (error) {
    console.error('Erro ao registrar cadastro pendente de empresa:', error);
    return res.status(500).json({ error: 'Erro interno ao criar a conta.' });
  }

  transporter.sendMail({
    to: email,
    subject: 'Confirme seu cadastro - SchedNext',
    html: emailHtml({
      titulo: `Bem-vindo(a) à SchedNext, ${nome}!`,
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Use o código abaixo para confirmar o cadastro do seu negócio:</p>
        ${blocoCodigo(codigoVerificacao)}
        <p style="margin: 0; color: #666; font-size: 13px;">Esse código expira em 30 minutos.</p>
      `
    })
  }, (mailErr) => {
    if (mailErr) console.error('Erro ao enviar e-mail de cadastro de empresa:', mailErr);
  });

  res.status(201).json({ message: 'Enviamos um código de confirmação pro seu e-mail.' });
});

router.post('/empresas/confirmar-codigo', codigoLimiter, validate(confirmarCodigoSchema), async (req, res) => {
  const { email, codigo } = req.body;

  const pendente = await buscarPendenteValido({ tipo: 'empresa', email, codigo });
  if (!pendente) return res.status(400).json({ error: 'Código inválido ou expirado.' });

  const { nome, slug, senha, vertical, plano_plataforma_id, plano_plataforma_pendente_id, plano_nome, status_assinatura, horarios_funcionamento } = pendente.dados;

  // Rechecagem: o slug/e-mail pode ter sido tomado por outra empresa enquanto este
  // cadastro ficava pendente de confirmação.
  const { data: slugExistente } = await supabase.from('empresas').select('id').eq('slug', slug).maybeSingle();
  if (slugExistente) return res.status(400).json({ error: 'Esse endereço foi registrado por outra conta enquanto você confirmava. Cadastre-se de novo com outro endereço.' });

  const { data: emailExistente } = await supabase.from('empresas').select('id').eq('email', email).maybeSingle();
  if (emailExistente) return res.status(400).json({ error: 'Já existe uma empresa cadastrada com esse e-mail.' });

  const { data: empresa, error } = await supabase
    .from('empresas')
    .insert({ nome, slug, email, senha, vertical, plano_plataforma_id, plano_plataforma_pendente_id, status_assinatura, horarios_funcionamento })
    .select('id, nome, slug')
    .single();

  if (error) {
    console.error('Erro ao ativar empresa:', error);
    return res.status(500).json({ error: 'Erro ao ativar a conta.' });
  }

  await removerPendente(pendente.id);

  const token = jwt.sign({ empresa_id: empresa.id, tipo: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });

  res.status(201).json({
    message: plano_plataforma_pendente_id
      ? `Conta ativada no plano Grátis! Pra ativar o plano ${plano_nome}, finalize o pagamento na tela de Conta.`
      : 'Conta ativada com sucesso!',
    success: true,
    token,
    admin: { id: empresa.id, empresa_id: empresa.id, nome: empresa.nome, slug: empresa.slug },
    empresa_id: empresa.id,
    slug: empresa.slug,
    status_assinatura,
    plano_nome,
    planoPendente: !!plano_plataforma_pendente_id
  });
});

module.exports = router;
