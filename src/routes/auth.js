const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const validate = require('../middleware/validate');
const { loginLimiter, codigoLimiter } = require('../middleware/rateLimiters');
const {
  registrarSchema,
  loginSchema,
  confirmarCodigoSchema,
  recuperarSenhaSchema,
  resetarSenhaSchema,
  segurancaCodigoSchema,
  segurancaUpdateSchema,
  segurancaValidarSchema
} = require('../schemas');
const validarSenhaComMigracao = require('../utils/senha');
const { emailHtml, blocoCodigo } = require('../utils/emailTemplate');
const { criarPendente, buscarPendenteValido, removerPendente } = require('../services/cadastroPendente');

const router = express.Router();

router.post('/registrar', validate(registrarSchema), async (req, res) => {
  const { nome, nascimento, email, telefone, senha, empresaSlug } = req.body;
  const codigoVerificacao = Math.floor(100000 + Math.random() * 900000).toString();

  const { data: empresa, error: empErr } = await supabase
    .from('empresas')
    .select('id')
    .eq('slug', empresaSlug)
    .maybeSingle();

  if (empErr || !empresa) return res.status(404).json({ error: 'Empresa não encontrada' });

  const { data: usuarioExistente } = await supabase.from('usuarios').select('id').eq('email', email).maybeSingle();
  if (usuarioExistente) return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });

  const senhaHash = await bcrypt.hash(senha, 12);

  // Nada vai pra tabela `usuarios` ainda — fica em espera em `cadastros_pendentes` até o
  // código ser confirmado (ver services/cadastroPendente.js). Antes, a conta já era criada
  // aqui (com ativo:false) mas o /login nunca chegava a checar esse campo, então uma conta
  // não confirmada já conseguia logar normalmente.
  const { error } = await criarPendente({
    tipo: 'cliente',
    email,
    codigo: codigoVerificacao,
    dados: { nome, nascimento, telefone, senha: senhaHash, empresa_id: empresa.id }
  });

  if (error) {
    console.error('ERRO NO BANCO DE DADOS:', error);
    return res.status(500).json({ error: `Erro técnico: ${error.message}` });
  }

  transporter.sendMail({
    to: email,
    subject: 'Confirme seu cadastro - SchedNext',
    html: emailHtml({
      titulo: `Olá, ${nome}!`,
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Use o código abaixo para confirmar seu cadastro:</p>
        ${blocoCodigo(codigoVerificacao)}
        <p style="margin: 0; color: #666; font-size: 13px;">Esse código expira em 30 minutos.</p>
      `
    })
  }, (mailErr) => {
    if (mailErr) console.error('Erro ao enviar e-mail:', mailErr);
  });

  res.status(201).json({ message: 'Enviamos um código de confirmação pro seu e-mail.' });
});

router.post('/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, senha } = req.body;

  const { data: usuario, error } = await supabase
    .from('usuarios')
    .select('id, nome_completo, senha, ativo')
    .eq('email', email)
    .maybeSingle();

  if (error || !usuario) return res.status(401).json({ message: 'E-mail não encontrado' });

  try {
    const senhaValida = await validarSenhaComMigracao(usuario.senha, senha, (novoHash) =>
      supabase.from('usuarios').update({ senha: novoHash }).eq('id', usuario.id)
    );

    if (!senhaValida) {
      return res.status(401).json({ message: 'Senha incorreta' });
    }

    const token = jwt.sign({ id: usuario.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return res.json({
      message: 'Sucesso!',
      token,
      usuario: { id: usuario.id, nome: usuario.nome_completo }
    });
  } catch (e) {
    console.error('Erro no /login:', e);
    res.status(500).json({ message: 'Erro interno ao autenticar' });
  }
});

router.post('/confirmar-codigo', codigoLimiter, validate(confirmarCodigoSchema), async (req, res) => {
  const { email, codigo } = req.body;

  const pendente = await buscarPendenteValido({ tipo: 'cliente', email, codigo });
  if (!pendente) return res.status(400).json({ error: 'Código inválido ou expirado.' });

  const { nome, nascimento, telefone, senha, empresa_id } = pendente.dados;

  const { error } = await supabase.from('usuarios').insert({
    nome_completo: nome,
    data_nascimento: nascimento,
    email,
    telefone,
    senha,
    empresa_id,
    ativo: true,
    // Sem isso, um cliente que se auto-cadastra pelo site nunca aparece em Admin > Clientes
    // (routes/clientes.js filtra por tipo = 'cliente'). Só o cadastro rápido pelo admin
    // (routes/clientes.js /rapido) setava esse campo.
    tipo: 'cliente'
  });

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });
    console.error('Erro ao ativar conta:', error);
    return res.status(500).json({ error: 'Erro ao ativar conta.' });
  }

  await removerPendente(pendente.id);
  res.json({ message: 'Conta ativada!' });
});

router.post('/recuperar-senha', codigoLimiter, validate(recuperarSenhaSchema), async (req, res) => {
  const { email } = req.body;
  const codigo = Math.floor(100000 + Math.random() * 900000).toString();

  const { data, error } = await supabase
    .from('usuarios')
    .update({ codigo_verificacao: codigo })
    .eq('email', email)
    .select('id');

  if (error || !data || data.length === 0) return res.status(404).json({ error: 'E-mail não encontrado.' });

  transporter.sendMail({
    to: email,
    subject: 'Recuperação de senha - SchedNext',
    html: emailHtml({
      titulo: 'Recuperação de senha',
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Use o código abaixo para criar uma nova senha:</p>
        ${blocoCodigo(codigo)}
        <p style="margin: 0; color: #666; font-size: 13px;">Se você não pediu isso, pode ignorar este e-mail.</p>
      `
    })
  }).catch((mailErr) => console.error('Erro ao enviar e-mail de recuperação de senha:', mailErr));
  res.json({ message: 'Código enviado!' });
});

router.post('/resetar-senha', codigoLimiter, validate(resetarSenhaSchema), async (req, res) => {
  const { email, codigo, novaSenha } = req.body;
  const novaSenhaHash = await bcrypt.hash(novaSenha, 12);

  // O MySQL original comparava com TRIM(email) = TRIM(?); replicamos isso buscando
  // pelo código (mais seletivo) e comparando o e-mail já normalizado em JS.
  const { data: candidatos, error: selError } = await supabase
    .from('usuarios')
    .select('id, email')
    .eq('codigo_verificacao', codigo);

  if (selError) return res.status(500).json({ error: 'Erro interno.' });

  const alvo = (candidatos || []).find((u) => (u.email || '').trim() === (email || '').trim());
  if (!alvo) return res.status(400).json({ error: 'Código inválido ou expirado.' });

  const { error } = await supabase
    .from('usuarios')
    .update({ senha: novaSenhaHash, codigo_verificacao: null })
    .eq('id', alvo.id);

  if (error) return res.status(400).json({ error: 'Código inválido ou expirado.' });
  res.json({ message: 'Senha alterada!' });
});

router.post('/seguranca-codigo', codigoLimiter, validate(segurancaCodigoSchema), async (req, res) => {
  const { id } = req.body;
  const codigo = Math.floor(100000 + Math.random() * 900000).toString();

  const { error: updError } = await supabase.from('usuarios').update({ codigo_verificacao: codigo }).eq('id', id);
  if (updError) return res.status(500).json({ error: 'Erro ao gerar código' });

  const { data: user, error: selError } = await supabase.from('usuarios').select('email').eq('id', id).maybeSingle();
  if (selError || !user) return res.status(404).json({ error: 'Usuário não existe' });

  transporter.sendMail({
    to: user.email,
    subject: 'Código de segurança - SchedNext',
    html: emailHtml({
      titulo: 'Código de segurança',
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Use o código abaixo para confirmar a alteração dos seus dados:</p>
        ${blocoCodigo(codigo)}
        <p style="margin: 0; color: #666; font-size: 13px;">Se você não pediu isso, pode ignorar este e-mail.</p>
      `
    })
  }).catch((mailErr) => console.error('Erro ao enviar e-mail de código de segurança:', mailErr));
  res.json({ message: 'Código enviado com sucesso!' });
});

router.put('/seguranca-update/:id', codigoLimiter, validate(segurancaUpdateSchema), async (req, res) => {
  const { email, senha, codigo } = req.body;
  const userId = req.params.id;
  const senhaHash = await bcrypt.hash(senha, 12);

  const { data, error } = await supabase
    .from('usuarios')
    .update({ email, senha: senhaHash, codigo_verificacao: null })
    .eq('id', userId)
    .eq('codigo_verificacao', codigo)
    .select('id');

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Este e-mail já está em uso por outra conta.' });
    return res.status(500).json({ error: 'Erro ao atualizar dados de segurança.' });
  }

  if (!data || data.length === 0) {
    return res.status(400).json({ error: 'Código inválido ou expirado.' });
  }

  res.json({ message: 'Dados de segurança atualizados!' });
});

router.post('/seguranca-validar', codigoLimiter, validate(segurancaValidarSchema), async (req, res) => {
  const { id, codigo } = req.body;

  const { data, error } = await supabase
    .from('usuarios')
    .select('id')
    .eq('id', id)
    .eq('codigo_verificacao', codigo);

  if (error) return res.status(500).json({ error: 'Erro interno' });
  if (!data || data.length === 0) {
    return res.status(400).json({ error: 'Código inválido ou expirado.' });
  }
  res.json({ success: true, message: 'Código validado!' });
});

// --- LOGIN ADMINISTRATIVO (VISÃO DE DONO) ---
router.post('/admin/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, senha } = req.body;

  const { data: empresa, error } = await supabase
    .from('empresas')
    .select('id, nome, slug, senha')
    .eq('email', email)
    .maybeSingle();

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }

  if (!empresa) {
    return res.status(401).json({ success: false, error: 'E-mail ou senha da barbearia incorretos.' });
  }

  try {
    const senhaValida = await validarSenhaComMigracao(empresa.senha, senha, (novoHash) =>
      supabase.from('empresas').update({ senha: novoHash }).eq('id', empresa.id)
    );

    if (!senhaValida) {
      return res.status(401).json({ success: false, error: 'E-mail ou senha da barbearia incorretos.' });
    }

    // O ID da empresa será usado como empresa_id no Dashboard
    const token = jwt.sign({ empresa_id: empresa.id, tipo: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });

    res.json({
      success: true,
      token,
      admin: {
        id: empresa.id,
        empresa_id: empresa.id,
        nome: empresa.nome,
        slug: empresa.slug
      }
    });
  } catch (e) {
    console.error('Erro no /admin/login:', e);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

module.exports = router;
