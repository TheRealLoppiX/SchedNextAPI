const express = require('express');
const bcrypt = require('bcrypt');

const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { cadastroEmpresaLimiter } = require('../middleware/rateLimiters');
const { registrarEmpresaSchema } = require('../schemas');

const router = express.Router();

// Planos da plataforma (não confundir com planos_assinatura, que é o plano de
// fidelidade que a barbearia vende pro cliente dela) — usado pela landing e pelo
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
  let planoEscolhidoId = plano_plataforma_id || planoGratis?.id;

  const { data: plano } = await supabase.from('planos_plataforma').select('id, nome, preco_mensal').eq('id', planoEscolhidoId).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  // Plano Grátis ativa na hora; planos pagos entram em trial até a cobrança real ser
  // integrada (ver adapter de pagamento em src/services/pagamento.js) — ninguém fica
  // bloqueado esperando uma integração que ainda não existe.
  const statusInicial = plano.nome === 'Grátis' ? 'ativa' : 'trial';
  const senhaHash = await bcrypt.hash(senha, 12);

  const { data: empresa, error } = await supabase
    .from('empresas')
    .insert({
      nome,
      slug,
      email,
      senha: senhaHash,
      vertical,
      plano_plataforma_id: plano.id,
      status_assinatura: statusInicial,
      horarios_funcionamento: JSON.stringify({
        0: { aberto: false, abre: '08:00', fecha: '18:00', label: 'Domingo' },
        1: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Segunda-feira' },
        2: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Terça-feira' },
        3: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Quarta-feira' },
        4: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Quinta-feira' },
        5: { aberto: true, abre: '08:00', fecha: '20:00', label: 'Sexta-feira' },
        6: { aberto: true, abre: '08:00', fecha: '18:00', label: 'Sábado' }
      })
    })
    .select('id, slug')
    .single();

  if (error) {
    console.error('Erro ao registrar empresa:', error);
    return res.status(500).json({ error: 'Erro interno ao criar a conta.' });
  }

  res.status(201).json({
    message: 'Conta criada com sucesso!',
    empresa_id: empresa.id,
    slug: empresa.slug,
    status_assinatura: statusInicial,
    plano_nome: plano.nome
  });
});

module.exports = router;
