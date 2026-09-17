const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { loginLimiter } = require('../middleware/rateLimiters');
const { superAdminLoginSchema, superAdminCriarSchema, superAdminEditarSchema, leadStatusSchema } = require('../schemas');

const router = express.Router();

// Super admins (donos da plataforma) vivem na tabela `super_admins`, não mais em variável
// de .env: isso permite ter mais de um (ex: arthur@schednext.com.br, rafael@schednext.com.br),
// cada um só pode ser criado por quem já é super admin (ver POST /super-admin/super-admins
// abaixo) e só com e-mail @schednext.com.br. RLS está ativado na tabela sem nenhuma policy,
// então só o backend (service_role, que ignora RLS) consegue ler/escrever nela.
router.post('/super-admin/login', loginLimiter, validate(superAdminLoginSchema), async (req, res) => {
  const { email, senha } = req.body;

  const { data: superAdmin, error } = await supabase
    .from('super_admins')
    .select('id, email, senha_hash, ativo')
    .eq('email', email)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao verificar credenciais.' });
  if (!superAdmin || !superAdmin.ativo) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  const senhaValida = await bcrypt.compare(senha, superAdmin.senha_hash);
  if (!senhaValida) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  const token = jwt.sign(
    { tipo: 'super_admin', id: superAdmin.id, email: superAdmin.email },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ success: true, token });
});

// Lista os super admins existentes (sem o hash da senha) pra tela de gestão.
router.get('/super-admin/super-admins', async (req, res) => {
  const { data, error } = await supabase
    .from('super_admins')
    .select('id, email, ativo, criado_em, criado_por, foto_url')
    .order('criado_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao listar super admins.' });
  res.json(data);
});

// Só um super admin autenticado pode criar outro (o middleware verificarTokenSuperAdmin já
// garante isso pra tudo sob /super-admin). Restrito ao domínio @schednext.com.br pelo schema.
//
// Reautenticação (senha_atual): um token válido no localStorage só prova que ALGUÉM logou
// antes, não que é a mesma pessoa agora na frente da tela — um painel deixado aberto/
// desbloqueado por descuido não pode virar uma porta pra qualquer um criar seu próprio acesso
// de dono da plataforma. Por isso exige a senha de QUEM ESTÁ CRIANDO (não da conta nova) de
// novo aqui, mesmo já autenticado.
router.post('/super-admin/super-admins', loginLimiter, validate(superAdminCriarSchema), async (req, res) => {
  const { email, senha, senha_atual, foto_url } = req.body;

  const { data: quemEstaCriando, error: errQuemCria } = await supabase
    .from('super_admins')
    .select('senha_hash')
    .eq('id', req.superAdmin?.id)
    .maybeSingle();

  if (errQuemCria || !quemEstaCriando) return res.status(500).json({ error: 'Erro ao confirmar sua identidade.' });

  const senhaAtualValida = await bcrypt.compare(senha_atual, quemEstaCriando.senha_hash);
  if (!senhaAtualValida) return res.status(401).json({ error: 'Senha atual incorreta.' });

  const { data: existente } = await supabase.from('super_admins').select('id').eq('email', email).maybeSingle();
  if (existente) return res.status(409).json({ error: 'Já existe um super admin com esse e-mail.' });

  const senhaHash = await bcrypt.hash(senha, 12);
  const { data, error } = await supabase
    .from('super_admins')
    .insert({ email, senha_hash: senhaHash, criado_por: req.superAdmin?.id || null, foto_url: foto_url || null })
    .select('id, email, ativo, criado_em, foto_url')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao criar super admin.' });
  res.status(201).json(data);
});

// Identidade de quem está logado agora (pra front saber qual linha da lista é "a minha conta",
// já que dois super admins podem existir e só cada um edita a própria — ver PUT .../me abaixo).
// Busca fresco no banco em vez de confiar só no payload do JWT: o e-mail no token pode estar
// desatualizado se o admin trocou de e-mail depois de logar.
router.get('/super-admin/me', async (req, res) => {
  const { data, error } = await supabase
    .from('super_admins')
    .select('id, email, foto_url')
    .eq('id', req.superAdmin?.id)
    .maybeSingle();

  if (error || !data) return res.status(500).json({ error: 'Erro ao buscar sua conta.' });
  res.json(data);
});

// Edição do PRÓPRIO perfil — de propósito sem :id na rota, pra nunca abrir brecha de um super
// admin editar a conta de outro (decisão consciente: só autoedição, ver superAdminEditarSchema).
// Mesma reautenticação da criação: mudar e-mail/senha da própria conta de dono da plataforma
// exige confirmar a senha atual de novo, mesmo já com token válido.
router.put('/super-admin/super-admins/me', loginLimiter, validate(superAdminEditarSchema), async (req, res) => {
  const { email, senha, senha_atual, foto_url } = req.body;

  const { data: contaAtual, error: errContaAtual } = await supabase
    .from('super_admins')
    .select('id, email, senha_hash')
    .eq('id', req.superAdmin?.id)
    .maybeSingle();

  if (errContaAtual || !contaAtual) return res.status(500).json({ error: 'Erro ao confirmar sua identidade.' });

  const senhaAtualValida = await bcrypt.compare(senha_atual, contaAtual.senha_hash);
  if (!senhaAtualValida) return res.status(401).json({ error: 'Senha atual incorreta.' });

  const atualizacao = {};
  if (foto_url !== undefined) atualizacao.foto_url = foto_url || null;

  if (email && email !== contaAtual.email) {
    const { data: emailEmUso } = await supabase.from('super_admins').select('id').eq('email', email).neq('id', contaAtual.id).maybeSingle();
    if (emailEmUso) return res.status(409).json({ error: 'Já existe um super admin com esse e-mail.' });
    atualizacao.email = email;
  }

  if (senha) atualizacao.senha_hash = await bcrypt.hash(senha, 12);

  if (Object.keys(atualizacao).length === 0) {
    return res.status(400).json({ error: 'Nada para atualizar.' });
  }

  const { data, error } = await supabase
    .from('super_admins')
    .update(atualizacao)
    .eq('id', contaAtual.id)
    .select('id, email, ativo, criado_em, foto_url')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao atualizar seu perfil.' });
  res.json(data);
});

// Desativa (não apaga) um super admin — mantém o histórico de quem criou quem.
// Ninguém pode desativar a própria conta, pra nunca ficar sem nenhum super admin ativo.
router.delete('/super-admin/super-admins/:id', async (req, res) => {
  if (req.params.id === req.superAdmin?.id) {
    return res.status(400).json({ error: 'Você não pode remover a sua própria conta.' });
  }

  const { error } = await supabase.from('super_admins').update({ ativo: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao remover super admin.' });
  res.json({ success: true });
});

// Leads do formulário de contato do plano Enterprise (preenchido de dentro do admin de
// empresa ou pelo cadastro público — ver routes/empresa.js e routes/empresasPublico.js).
router.get('/super-admin/leads-enterprise', async (req, res) => {
  const { data, error } = await supabase
    .from('leads_enterprise')
    .select('*')
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: 'Erro ao buscar leads.' });
  res.json(data);
});

router.put('/super-admin/leads-enterprise/:id/status', validate(leadStatusSchema), async (req, res) => {
  const { error } = await supabase
    .from('leads_enterprise')
    .update({ status: req.body.status })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao atualizar status do lead.' });
  res.json({ success: true });
});

// Ativa o plano Enterprise pra empresa vinculada ao lead (negociação feita fora do sistema —
// o admin absoluto decide o valor combinado e, por ora, não há cobrança automática pro
// Enterprise, ver src/services/pagamento.js). Só funciona se o lead veio de uma empresa já
// cadastrada (empresa_id preenchido); leads de prospects sem conta ainda precisam se cadastrar
// primeiro.
router.post('/super-admin/leads-enterprise/:id/ativar-empresa', async (req, res) => {
  const { data: lead } = await supabase
    .from('leads_enterprise')
    .select('empresa_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!lead) return res.status(404).json({ error: 'Lead não encontrado.' });
  if (!lead.empresa_id) return res.status(400).json({ error: 'Esse lead não está vinculado a uma empresa cadastrada.' });

  const { data: planoEnterprise } = await supabase.from('planos_plataforma').select('id').eq('nome', 'Enterprise').maybeSingle();
  if (!planoEnterprise) return res.status(500).json({ error: 'Plano Enterprise não encontrado.' });

  const { error } = await supabase
    .from('empresas')
    .update({ plano_plataforma_id: planoEnterprise.id, status_assinatura: 'ativa', cancelamento_agendado: false })
    .eq('id', lead.empresa_id);

  if (error) return res.status(500).json({ error: 'Erro ao ativar o plano Enterprise pra essa empresa.' });

  await supabase.from('leads_enterprise').update({ status: 'fechado' }).eq('id', req.params.id);
  res.json({ success: true, message: 'Empresa ativada no plano Enterprise.' });
});

module.exports = router;
