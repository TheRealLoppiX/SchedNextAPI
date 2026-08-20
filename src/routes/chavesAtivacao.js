const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { chaveAtivacaoCriarSchema, chaveAtivacaoResgatarSchema } = require('../schemas');

const router = express.Router();

// Sem 0/O/1/I — pra não confundir quando alguém digita a chave manualmente em vez de colar.
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function gerarCodigo() {
  const bytes = crypto.randomBytes(16);
  let codigo = '';
  for (let i = 0; i < bytes.length; i++) codigo += ALFABETO_CODIGO[bytes[i] % ALFABETO_CODIGO.length];
  return codigo.match(/.{1,4}/g).join('-');
}

// --- Super admin: gerar e gerenciar chaves de ativação de plano ---
// Protegidas pelo verificarTokenSuperAdmin de todo o prefixo /super-admin/* (ver server.js).

router.post('/super-admin/chaves-ativacao', validate(chaveAtivacaoCriarSchema), async (req, res) => {
  const { plano_plataforma_id, duracao_dias, quantidade, observacao, prazo_resgate_dias } = req.body;

  const { data: plano, error: errPlano } = await supabase
    .from('planos_plataforma')
    .select('id')
    .eq('id', plano_plataforma_id)
    .maybeSingle();
  if (errPlano || !plano) return res.status(400).json({ error: 'Plano inválido.' });

  const prazoResgateAte = prazo_resgate_dias ? new Date(Date.now() + prazo_resgate_dias * 86400000).toISOString() : null;

  const linhas = Array.from({ length: quantidade }, () => ({
    codigo: gerarCodigo(),
    plano_plataforma_id,
    duracao_dias,
    observacao: observacao || null,
    criado_por_super_admin_id: req.superAdmin?.id || null,
    prazo_resgate_ate: prazoResgateAte
  }));

  const { data, error } = await supabase
    .from('chaves_ativacao')
    .insert(linhas)
    .select('id, codigo, plano_plataforma_id, duracao_dias, observacao, criado_em, prazo_resgate_ate');

  if (error) return res.status(500).json({ error: 'Erro ao criar chave(s).' });
  res.status(201).json(data);
});

router.get('/super-admin/chaves-ativacao', async (req, res) => {
  const { data, error } = await supabase
    .from('chaves_ativacao')
    .select('id, codigo, duracao_dias, observacao, criado_em, prazo_resgate_ate, usada_em, revogada_em, plano_plataforma:plano_plataforma_id(nome), usada_por_empresa:usada_por_empresa_id(nome)')
    .order('criado_em', { ascending: false })
    .limit(500);

  if (error) return res.status(500).json({ error: 'Erro ao listar chaves.' });
  res.json(data);
});

// Só dá pra revogar uma chave que ainda não foi resgatada — uma vez usada, ela já concedeu o
// plano pra empresa; desfazer isso é papel do cron de expiração (src/cron/assinaturas.js), não
// dessa rota.
router.post('/super-admin/chaves-ativacao/:id/revogar', async (req, res) => {
  const { data: chave } = await supabase
    .from('chaves_ativacao')
    .select('id, usada_em, revogada_em')
    .eq('id', req.params.id)
    .maybeSingle();

  if (!chave) return res.status(404).json({ error: 'Chave não encontrada.' });
  if (chave.usada_em) return res.status(400).json({ error: 'Essa chave já foi usada, não é possível revogar.' });
  if (chave.revogada_em) return res.status(400).json({ error: 'Essa chave já está revogada.' });

  const { error } = await supabase
    .from('chaves_ativacao')
    .update({ revogada_em: new Date().toISOString() })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao revogar chave.' });
  res.json({ success: true });
});

// --- Admin de empresa: resgatar uma chave ---
// Sob /admin/*, protegida pelo verificarTokenAdmin (ver server.js). De propósito fora da
// allowlist ROTAS_PERMITIDAS_ADMIN_UNIDADE: só o admin dono da empresa (não um admin de
// unidade) mexe no plano da plataforma, igual as demais rotas de assinatura-plataforma.

router.post('/admin/assinatura-plataforma/ativar-chave', validate(chaveAtivacaoResgatarSchema), async (req, res) => {
  const empresaId = req.empresaId;
  const codigo = req.body.codigo.trim().toUpperCase();

  const { data: chave, error } = await supabase
    .from('chaves_ativacao')
    .select('id, plano_plataforma_id, duracao_dias, usada_em, revogada_em, prazo_resgate_ate, plano_plataforma:plano_plataforma_id(id, nome)')
    .eq('codigo', codigo)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao validar a chave.' });
  if (!chave) return res.status(404).json({ error: 'Chave inválida.' });
  if (chave.revogada_em) return res.status(400).json({ error: 'Essa chave foi revogada.' });
  if (chave.usada_em) return res.status(400).json({ error: 'Essa chave já foi usada.' });
  if (chave.prazo_resgate_ate && new Date(chave.prazo_resgate_ate) < new Date()) {
    return res.status(400).json({ error: 'Essa chave expirou e não pode mais ser resgatada.' });
  }

  const { data: empresaAtual } = await supabase
    .from('empresas')
    .select('chave_ativacao_expira_em')
    .eq('id', empresaId)
    .maybeSingle();
  if (empresaAtual?.chave_ativacao_expira_em && new Date(empresaAtual.chave_ativacao_expira_em) > new Date()) {
    return res.status(400).json({ error: 'Sua empresa já tem uma chave ativa em andamento. Aguarde ela expirar para resgatar outra.' });
  }

  // Marca a chave como usada condicionado a ainda estar livre (usada_em/revogada_em IS NULL) —
  // fecha a corrida de duas requisições resgatando a mesma chave ao mesmo tempo: só uma
  // consegue dar o UPDATE, a outra não encontra linha e cai no 409 abaixo.
  const { data: chaveMarcada, error: errMarcar } = await supabase
    .from('chaves_ativacao')
    .update({ usada_em: new Date().toISOString(), usada_por_empresa_id: empresaId })
    .eq('id', chave.id)
    .is('usada_em', null)
    .is('revogada_em', null)
    .select('id')
    .maybeSingle();

  if (errMarcar) return res.status(500).json({ error: 'Erro ao ativar a chave.' });
  if (!chaveMarcada) return res.status(409).json({ error: 'Essa chave acabou de ser usada ou revogada. Tente outra.' });

  const expiraEm = new Date(Date.now() + chave.duracao_dias * 86400000).toISOString();

  const { error: errEmpresa } = await supabase
    .from('empresas')
    .update({
      plano_plataforma_id: chave.plano_plataforma_id,
      plano_plataforma_pendente_id: null,
      status_assinatura: 'ativa',
      chave_ativacao_expira_em: expiraEm
    })
    .eq('id', empresaId);

  if (errEmpresa) return res.status(500).json({ error: 'Chave validada, mas houve erro ao ativar o plano. Fale com o suporte.' });

  res.json({
    success: true,
    message: `Plano ${chave.plano_plataforma.nome} ativado até ${new Date(expiraEm).toLocaleDateString('pt-BR')}.`,
    plano: chave.plano_plataforma.nome,
    expira_em: expiraEm
  });
});

module.exports = router;
