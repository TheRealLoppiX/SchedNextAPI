const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { loginLimiter } = require('../middleware/rateLimiters');
const { superAdminLoginSchema, superAdminCriarSchema, leadStatusSchema } = require('../schemas');

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
    .select('id, email, ativo, criado_em, criado_por')
    .order('criado_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao listar super admins.' });
  res.json(data);
});

// Só um super admin autenticado pode criar outro (o middleware verificarTokenSuperAdmin já
// garante isso pra tudo sob /super-admin). Restrito ao domínio @schednext.com.br pelo schema.
router.post('/super-admin/super-admins', validate(superAdminCriarSchema), async (req, res) => {
  const { email, senha } = req.body;

  const { data: existente } = await supabase.from('super_admins').select('id').eq('email', email).maybeSingle();
  if (existente) return res.status(409).json({ error: 'Já existe um super admin com esse e-mail.' });

  const senhaHash = await bcrypt.hash(senha, 12);
  const { data, error } = await supabase
    .from('super_admins')
    .insert({ email, senha_hash: senhaHash, criado_por: req.superAdmin?.id || null })
    .select('id, email, ativo, criado_em')
    .single();

  if (error) return res.status(500).json({ error: 'Erro ao criar super admin.' });
  res.status(201).json(data);
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
