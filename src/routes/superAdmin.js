const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { loginLimiter } = require('../middleware/rateLimiters');
const { superAdminLoginSchema, leadStatusSchema } = require('../schemas');

const router = express.Router();

// Conta única do dono da plataforma, sem tabela própria — credenciais vêm do .env
// (SUPER_ADMIN_EMAIL + SUPER_ADMIN_SENHA_HASH, um hash bcrypt gerado localmente, nunca a
// senha em texto puro). Ver src/middleware/superAdminAuth.js pra como o token é checado.
router.post('/super-admin/login', loginLimiter, validate(superAdminLoginSchema), async (req, res) => {
  const { email, senha } = req.body;

  const emailEsperado = process.env.SUPER_ADMIN_EMAIL;
  const hashEsperado = process.env.SUPER_ADMIN_SENHA_HASH;

  if (!emailEsperado || !hashEsperado) {
    console.error('SUPER_ADMIN_EMAIL/SUPER_ADMIN_SENHA_HASH não configurados.');
    return res.status(503).json({ error: 'Login do admin absoluto não está configurado.' });
  }

  if (email !== emailEsperado.toLowerCase()) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  const senhaValida = await bcrypt.compare(senha, hashEsperado);
  if (!senhaValida) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  const token = jwt.sign({ tipo: 'super_admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ success: true, token });
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
