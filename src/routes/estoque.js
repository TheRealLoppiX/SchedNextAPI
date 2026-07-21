const express = require('express');
const bcrypt = require('bcrypt');

const supabase = require('../config/supabase');
const { loginLimiter } = require('../middleware/rateLimiters');
const validarSenhaComMigracao = require('../utils/senha');

const router = express.Router();

router.get('/admin/estoque/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('produtos')
    .select('*')
    .eq('empresa_id', req.params.empresaId)
    .order('nome', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao buscar estoque' });
  res.json(data);
});

router.post('/admin/estoque', async (req, res) => {
  const { empresa_id, nome, valor, quantidade } = req.body;

  const { error } = await supabase.from('produtos').insert({ empresa_id, nome, valor, quantidade });
  if (error) {
    console.error('Erro no BD:', error);
    return res.status(500).json({ error: 'Erro ao cadastrar produto' });
  }
  res.json({ message: 'Produto cadastrado com sucesso!' });
});

router.put('/admin/estoque/:id', async (req, res) => {
  const { nome, valor, quantidade } = req.body;
  const { error } = await supabase.from('produtos').update({ nome, valor, quantidade }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar produto' });
  res.json({ message: 'Produto atualizado!' });
});

router.put('/admin/estoque/:id/status', async (req, res) => {
  const { ativo } = req.body;
  const { error } = await supabase.from('produtos').update({ ativo: !!ativo }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao atualizar status' });
  res.json({ message: 'Status atualizado!' });
});

router.delete('/admin/estoque/:id', async (req, res) => {
  const { error } = await supabase.from('produtos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Não é possível excluir. Recomendamos inativar.' });
  res.json({ message: 'Produto excluído!' });
});

// 1. LISTAR USUÁRIOS PARA O DROPDOWN DE LOGIN
router.get('/admin/estoque/usuarios/:empresaId', async (req, res) => {
  const { data, error } = await supabase.from('estoque_usuarios').select('id, nome').eq('empresa_id', req.params.empresaId);
  if (error) return res.status(500).json({ error: 'Erro ao buscar usuários.' });
  res.json(data);
});

// 2. LOGIN DO ESTOQUE (blindado contra acessos cruzados)
router.post('/admin/estoque/login', loginLimiter, async (req, res) => {
  const { empresa_id, usuario, senha } = req.body;

  if (usuario === 'admin') {
    const { data: empresa, error } = await supabase.from('empresas').select('id, senha').eq('id', empresa_id).maybeSingle();
    if (error || !empresa) return res.status(401).json({ error: 'Senha do Administrador incorreta.' });

    const valido = await validarSenhaComMigracao(empresa.senha, senha, (novoHash) =>
      supabase.from('empresas').update({ senha: novoHash }).eq('id', empresa.id)
    );
    if (!valido) return res.status(401).json({ error: 'Senha do Administrador incorreta.' });
    return res.json({ success: true, nivel: 'admin', nome: 'Administrador' });
  }

  const { data: colaborador, error } = await supabase
    .from('estoque_usuarios')
    .select('id, nome, senha')
    .eq('empresa_id', empresa_id)
    .eq('nome', usuario)
    .maybeSingle();

  if (error || !colaborador) return res.status(401).json({ error: 'Senha do colaborador incorreta.' });

  const valido = await validarSenhaComMigracao(colaborador.senha, senha, (novoHash) =>
    supabase.from('estoque_usuarios').update({ senha: novoHash }).eq('id', colaborador.id)
  );
  if (!valido) return res.status(401).json({ error: 'Senha do colaborador incorreta.' });
  res.json({ success: true, nivel: 'colaborador', nome: colaborador.nome });
});

// 2. Criar sublogin (Somente via senha do admin)
router.post('/admin/estoque/criar-sublogin', async (req, res) => {
  const { empresa_id, senha_admin, novo_nome, nova_senha } = req.body;

  const { data: empresa, error } = await supabase.from('empresas').select('id, senha').eq('id', empresa_id).maybeSingle();
  if (error || !empresa) return res.status(403).json({ error: 'Senha administrativa incorreta.' });

  const valido = await validarSenhaComMigracao(empresa.senha, senha_admin, (novoHash) =>
    supabase.from('empresas').update({ senha: novoHash }).eq('id', empresa.id)
  );
  if (!valido) return res.status(403).json({ error: 'Senha administrativa incorreta.' });

  const novaSenhaHash = await bcrypt.hash(nova_senha, 12);
  const { error: insError } = await supabase
    .from('estoque_usuarios')
    .insert({ empresa_id, nome: novo_nome, senha: novaSenhaHash });

  if (insError) return res.status(500).json({ error: 'Erro ao criar acesso.' });
  res.json({ message: 'Acesso criado com sucesso!' });
});

// 3. Movimentar Estoque (Com justificativa)
router.post('/admin/estoque/movimentar', async (req, res) => {
  const { produto_id, usuario_nome, quantidade, tipo, justificativa } = req.body;

  const { data: produto, error: selError } = await supabase.from('produtos').select('quantidade').eq('id', produto_id).maybeSingle();
  if (selError || !produto) return res.status(500).json({ error: 'Erro ao atualizar estoque.' });

  const novaQuantidade = tipo === 'ADICIONAR' ? produto.quantidade + quantidade : produto.quantidade - quantidade;

  const { error: updError } = await supabase.from('produtos').update({ quantidade: novaQuantidade }).eq('id', produto_id);
  if (updError) return res.status(500).json({ error: 'Erro ao atualizar estoque.' });

  await supabase.from('estoque_movimentacoes').insert({ produto_id, usuario_nome, quantidade, tipo, justificativa });
  res.json({ message: 'Movimentação registrada!' });
});

// 4. RELATÓRIO DE ESTOQUE (Auditoria por data)
router.get('/admin/estoque/relatorio/:empresaId', async (req, res) => {
  const { empresaId } = req.params;
  const { inicio, fim } = req.query;

  // Nota: estoque_movimentacoes.produto_id não tem FK real no banco (igual no MySQL original),
  // então o PostgREST não consegue fazer o embed automático — buscamos os produtos da empresa
  // primeiro e juntamos em JS.
  const { data: produtos, error: prodErr } = await supabase.from('produtos').select('id, nome').eq('empresa_id', empresaId);
  if (prodErr) return res.status(500).json({ error: 'Erro ao buscar relatório.' });

  const produtoIds = produtos.map((p) => p.id);
  const nomePorProduto = Object.fromEntries(produtos.map((p) => [p.id, p.nome]));

  if (produtoIds.length === 0) return res.json([]);

  const { data, error } = await supabase
    .from('estoque_movimentacoes')
    .select('*')
    .in('produto_id', produtoIds)
    .gte('data_movimentacao', `${inicio}T00:00:00`)
    .lte('data_movimentacao', `${fim}T23:59:59`)
    .order('data_movimentacao', { ascending: false });

  if (error) {
    console.error('Erro ao buscar relatório:', error);
    return res.status(500).json({ error: 'Erro ao buscar relatório.' });
  }

  res.json(
    data.map((m) => ({
      ...m,
      produto_nome: nomePorProduto[m.produto_id]
    }))
  );
});

module.exports = router;
