const express = require('express');
const bcrypt = require('bcrypt');

const supabase = require('../config/supabase');
const { loginLimiter } = require('../middleware/rateLimiters');
const { permiteRelatorioProdutos } = require('../utils/limitesPlano');
const validarSenhaComMigracao = require('../utils/senha');
const validate = require('../middleware/validate');
const {
  estoqueProdutoSchema,
  ativoSchema,
  estoqueLoginSchema,
  estoqueCriarSubloginSchema,
  estoqueMovimentarSchema,
  estoqueExcluirSchema
} = require('../schemas');

const router = express.Router();

// Toda esta rota vive sob /admin/*, então verificarTokenAdmin (server.js) já garantiu que
// req.empresaId é o tenant do dono autenticado. Usamos sempre esse valor, nunca um
// empresa_id/:empresaId vindo do cliente, senão um admin autenticado de uma empresa
// conseguiria ler/escrever o estoque (e as credenciais de sublogin) de outra.

// Produto cadastrado sem código de barras ganha um código interno: EAN-13 começando com 200
// (faixa reservada pra uso interno, nunca colide com código de fábrica), com o id do produto e
// dígito verificador, então dá pra imprimir etiqueta e ler com o mesmo leitor.
// sql/2026_estoque_venda_uso_codigo_barras.sql gera o mesmo formato pros produtos antigos.
function gerarCodigoInterno(produtoId) {
  const base = `200${String(produtoId).padStart(9, '0')}`;
  const soma = base.split('').reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${base}${(10 - (soma % 10)) % 10}`;
}

const ERRO_CODIGO_DUPLICADO = 'Já existe um produto com esse código de barras.';
const ehCodigoDuplicado = (error) => error?.code === '23505';

// ?tipo=venda|uso filtra; sem filtro vem tudo (a tela de estoque separa em abas).
router.get('/admin/estoque/:empresaId', async (req, res) => {
  let query = supabase
    .from('produtos')
    .select('*')
    .eq('empresa_id', req.empresaId)
    .is('excluido_em', null)
    .order('nome', { ascending: true });
  if (['venda', 'uso'].includes(req.query.tipo)) query = query.eq('tipo', req.query.tipo);

  const { data, error } = await query;
  if (error) {
    console.error('Erro ao listar estoque:', error);
    return res.status(500).json({ error: 'Erro ao buscar estoque' });
  }
  res.json(data);
});

// Leitura de código de barras (câmera ou leitor USB) na tela de estoque: acha o produto já
// cadastrado, ou 404 pra tela oferecer o cadastro com o código já preenchido.
router.get('/admin/estoque/codigo/:codigo', async (req, res) => {
  const { data, error } = await supabase
    .from('produtos')
    .select('*')
    .eq('empresa_id', req.empresaId)
    .eq('codigo_barras', String(req.params.codigo).trim())
    .is('excluido_em', null)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar produto.' });
  if (!data) return res.status(404).json({ error: 'Nenhum produto com esse código.' });
  res.json(data);
});

router.post('/admin/estoque', validate(estoqueProdutoSchema), async (req, res) => {
  const { nome, tipo, codigo_barras, valor, custo, data_compra, quantidade, usuario_nome } = req.body;

  const { data: produto, error } = await supabase
    .from('produtos')
    .insert({
      empresa_id: req.empresaId,
      nome,
      tipo,
      codigo_barras: codigo_barras || null,
      valor: tipo === 'uso' ? null : valor,
      custo: custo ?? null,
      quantidade
    })
    .select('id')
    .single();

  if (error) {
    if (ehCodigoDuplicado(error)) return res.status(400).json({ error: ERRO_CODIGO_DUPLICADO });
    console.error('Erro no BD:', error);
    return res.status(500).json({ error: 'Erro ao cadastrar produto' });
  }

  let codigoFinal = codigo_barras;
  if (!codigoFinal) {
    codigoFinal = gerarCodigoInterno(produto.id);
    const { error: codErr } = await supabase.from('produtos').update({ codigo_barras: codigoFinal }).eq('id', produto.id);
    if (codErr) console.error('Erro ao gravar código interno do produto:', codErr);
  }

  // Estoque inicial entra como uma compra no histórico: aparece na auditoria e, com custo
  // informado, no relatório de gastos.
  if (quantidade > 0) {
    const { error: movError } = await supabase.from('estoque_movimentacoes').insert({
      produto_id: produto.id,
      usuario_nome: usuario_nome || 'Administrador',
      quantidade,
      tipo: 'ADICIONAR',
      justificativa: 'Estoque inicial no cadastro',
      custo_unitario: custo ?? null,
      data_compra: data_compra || null
    });
    if (movError) console.error('Erro ao registrar estoque inicial do produto:', movError);
  }

  res.json({ message: 'Produto cadastrado com sucesso!', id: produto.id, codigo_barras: codigoFinal });
});

// Quantidade não muda aqui, só por movimentação (entrada/saída com histórico).
router.put('/admin/estoque/:id', validate(estoqueProdutoSchema), async (req, res) => {
  const { nome, tipo, codigo_barras, valor, custo } = req.body;
  const { data, error } = await supabase
    .from('produtos')
    .update({
      nome,
      tipo,
      // Apagar o código na edição devolve o código interno do sistema.
      codigo_barras: codigo_barras || gerarCodigoInterno(req.params.id),
      valor: tipo === 'uso' ? null : valor,
      custo: custo ?? null
    })
    .eq('id', req.params.id)
    .eq('empresa_id', req.empresaId)
    .is('excluido_em', null)
    .select('id');

  if (error) {
    if (ehCodigoDuplicado(error)) return res.status(400).json({ error: ERRO_CODIGO_DUPLICADO });
    return res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
  if (!data || data.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json({ message: 'Produto atualizado!' });
});

router.put('/admin/estoque/:id/status', validate(ativoSchema), async (req, res) => {
  const { ativo } = req.body;
  const { data, error } = await supabase
    .from('produtos')
    .update({ ativo: !!ativo })
    .eq('id', req.params.id)
    .eq('empresa_id', req.empresaId)
    .is('excluido_em', null)
    .select('id');

  if (error) return res.status(500).json({ error: 'Erro ao atualizar status' });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json({ message: 'Status atualizado!' });
});

// Excluir = arquivar com justificativa: o produto some do estoque, do caixa e das buscas, mas a
// linha fica pra relatórios, vendas e histórico continuarem com o nome dele. A exclusão entra no
// histórico de auditoria (tipo EXCLUSAO) com operador, quantidade que havia e motivo.
router.delete('/admin/estoque/:id', validate(estoqueExcluirSchema), async (req, res) => {
  const { justificativa, usuario_nome } = req.body;

  const { data, error } = await supabase
    .from('produtos')
    .update({ excluido_em: new Date().toISOString(), ativo: false })
    .eq('id', req.params.id)
    .eq('empresa_id', req.empresaId)
    .is('excluido_em', null)
    .select('id, quantidade');

  if (error) {
    console.error('Erro ao excluir produto:', error);
    return res.status(500).json({ error: 'Erro ao excluir produto.' });
  }
  if (!data || data.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });

  const { error: movError } = await supabase.from('estoque_movimentacoes').insert({
    produto_id: data[0].id,
    usuario_nome: usuario_nome || 'Administrador',
    quantidade: Math.max(Number(data[0].quantidade) || 0, 0),
    tipo: 'EXCLUSAO',
    justificativa
  });
  if (movError) console.error('Erro ao registrar exclusão de produto no histórico:', movError);

  res.json({ message: 'Produto excluído!' });
});

// 1. LISTAR USUÁRIOS PARA O DROPDOWN DE LOGIN
router.get('/admin/estoque/usuarios/:empresaId', async (req, res) => {
  const { data, error } = await supabase.from('estoque_usuarios').select('id, nome').eq('empresa_id', req.empresaId);
  if (error) return res.status(500).json({ error: 'Erro ao buscar usuários.' });
  res.json(data);
});

// 2. LOGIN DO ESTOQUE (blindado contra acessos cruzados)
router.post('/admin/estoque/login', loginLimiter, validate(estoqueLoginSchema), async (req, res) => {
  const { usuario, senha } = req.body;
  const empresa_id = req.empresaId;

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
router.post('/admin/estoque/criar-sublogin', validate(estoqueCriarSubloginSchema), async (req, res) => {
  const { senha_admin, novo_nome, nova_senha } = req.body;
  const empresa_id = req.empresaId;

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
router.post('/admin/estoque/movimentar', validate(estoqueMovimentarSchema), async (req, res) => {
  const { produto_id, usuario_nome, quantidade, justificativa, custo_unitario, data_compra } = req.body;
  const tipo = req.body.tipo === 'RETIRAR' ? 'REMOVER' : req.body.tipo;
  const delta = tipo === 'ADICIONAR' ? quantidade : -quantidade;
  const ehCompra = tipo === 'ADICIONAR';

  // Incremento atômico via function no Postgres (ver movimentar_estoque no banco) em vez de
  // ler a quantidade, calcular em JS e gravar depois: duas movimentações concorrentes no
  // mesmo produto podiam ler o mesmo valor inicial e a segunda gravação sobrescrever a
  // primeira (lost update). A function também recusa deixar a quantidade negativa.
  const { data, error } = await supabase.rpc('movimentar_estoque', {
    p_produto_id: produto_id,
    p_empresa_id: req.empresaId,
    p_delta: delta
  });

  if (error) return res.status(500).json({ error: 'Erro ao atualizar estoque.' });
  if (!data || data.length === 0) {
    return res.status(400).json({ error: 'Produto não encontrado ou estoque insuficiente para essa remoção.' });
  }

  const { error: movError } = await supabase.from('estoque_movimentacoes').insert({
    produto_id,
    usuario_nome,
    quantidade,
    tipo,
    justificativa,
    custo_unitario: ehCompra ? (custo_unitario ?? null) : null,
    data_compra: ehCompra ? (data_compra || null) : null
  });
  if (movError) console.error('Erro ao registrar movimentação de estoque (quantidade já foi atualizada):', movError);

  // Custo da compra mais recente vira o custo do produto, usado pra congelar o custo em cada
  // venda (receita líquida por produto).
  if (ehCompra && custo_unitario != null) {
    await supabase.from('produtos').update({ custo: custo_unitario }).eq('id', produto_id).eq('empresa_id', req.empresaId);
  }

  res.json({ message: 'Movimentação registrada!' });
});

// 4. RELATÓRIO DE ESTOQUE (Auditoria por data)
router.get('/admin/estoque/relatorio/:empresaId', async (req, res) => {
  const { inicio, fim } = req.query;

  // estoque_movimentacoes.produto_id não tem FK real no banco (igual no MySQL original),
  // então o PostgREST não consegue fazer o embed automático. Buscamos os produtos da empresa
  // primeiro e juntamos em JS.
  const { data: produtos, error: prodErr } = await supabase.from('produtos').select('id, nome').eq('empresa_id', req.empresaId);
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

// 5. RELATÓRIO FINANCEIRO DO ESTOQUE
// Gastos: toda entrada com custo informado, pela data da compra (ou da entrada, se a data da
// compra ficou em branco), separada em produtos de uso e de venda. Vale pra todo plano.
// Vendas: receita, custo e receita líquida por produto vendido no caixa (produto_vendas, com
// preço e custo congelados na venda). Recurso de plano, do Profissional pra cima.
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const arredondar = (v) => Math.round(v * 100) / 100;

router.get('/admin/estoque/financeiro/:empresaId', async (req, res) => {
  const { inicio, fim } = req.query;
  if (!DATA_ISO.test(inicio || '') || !DATA_ISO.test(fim || '')) {
    return res.status(400).json({ error: 'Informe o período (inicio e fim).' });
  }

  const { data: produtos, error: prodErr } = await supabase
    .from('produtos')
    .select('id, nome, tipo')
    .eq('empresa_id', req.empresaId);
  if (prodErr) return res.status(500).json({ error: 'Erro ao buscar relatório.' });

  const produtoPorId = Object.fromEntries((produtos || []).map((p) => [p.id, p]));
  const produtoIds = Object.keys(produtoPorId).map(Number);

  let compras = [];
  if (produtoIds.length > 0) {
    const { data, error } = await supabase
      .from('estoque_movimentacoes')
      .select('produto_id, quantidade, custo_unitario, data_compra, data_movimentacao')
      .in('produto_id', produtoIds)
      .eq('tipo', 'ADICIONAR')
      .not('custo_unitario', 'is', null)
      .or(`and(data_compra.gte.${inicio},data_compra.lte.${fim}),and(data_compra.is.null,data_movimentacao.gte.${inicio}T00:00:00,data_movimentacao.lte.${fim}T23:59:59)`);
    if (error) {
      console.error('Erro ao buscar compras do estoque:', error);
      return res.status(500).json({ error: 'Erro ao buscar relatório.' });
    }
    compras = data || [];
  }

  const gastosPorProduto = {};
  const gastosPorTipo = { uso: 0, venda: 0 };
  for (const c of compras) {
    const produto = produtoPorId[c.produto_id];
    const total = Number(c.custo_unitario) * c.quantidade;
    const linha = gastosPorProduto[c.produto_id] || (gastosPorProduto[c.produto_id] = {
      produto_id: c.produto_id, nome: produto?.nome || 'Produto removido', tipo: produto?.tipo || 'venda', quantidade: 0, total: 0
    });
    linha.quantidade += c.quantidade;
    linha.total += total;
    gastosPorTipo[linha.tipo] += total;
  }

  const gastos = {
    total: arredondar(gastosPorTipo.uso + gastosPorTipo.venda),
    uso: arredondar(gastosPorTipo.uso),
    venda: arredondar(gastosPorTipo.venda),
    por_produto: Object.values(gastosPorProduto)
      .map((l) => ({ ...l, total: arredondar(l.total) }))
      .sort((x, y) => y.total - x.total)
  };

  const permitido = await permiteRelatorioProdutos(req.empresaId);
  if (!permitido) return res.json({ gastos, vendas: null, permite_relatorio_produtos: false });

  const { data: vendasBrutas, error: vendErr } = await supabase
    .from('produto_vendas')
    .select('produto_id, quantidade, preco_unitario, custo_unitario')
    .eq('empresa_id', req.empresaId)
    .gte('vendido_em', `${inicio}T00:00:00`)
    .lte('vendido_em', `${fim}T23:59:59`);
  if (vendErr) {
    console.error('Erro ao buscar vendas de produto:', vendErr);
    return res.status(500).json({ error: 'Erro ao buscar relatório.' });
  }

  const vendasPorProduto = {};
  for (const v of vendasBrutas || []) {
    const linha = vendasPorProduto[v.produto_id] || (vendasPorProduto[v.produto_id] = {
      produto_id: v.produto_id, nome: produtoPorId[v.produto_id]?.nome || 'Produto removido',
      quantidade: 0, receita: 0, custo: 0, unidades_sem_custo: 0
    });
    linha.quantidade += v.quantidade;
    linha.receita += Number(v.preco_unitario) * v.quantidade;
    // Venda sem custo cadastrado entra com custo zero, e a tela avisa quantas unidades foram.
    if (v.custo_unitario == null) linha.unidades_sem_custo += v.quantidade;
    else linha.custo += Number(v.custo_unitario) * v.quantidade;
  }

  const porProduto = Object.values(vendasPorProduto).map((l) => {
    const liquida = l.receita - l.custo;
    return {
      ...l,
      receita: arredondar(l.receita),
      custo: arredondar(l.custo),
      receita_liquida: arredondar(liquida),
      margem_percentual: l.receita > 0 ? arredondar((liquida / l.receita) * 100) : null
    };
  }).sort((x, y) => y.receita_liquida - x.receita_liquida);

  const receita = porProduto.reduce((acc, l) => acc + l.receita, 0);
  const custo = porProduto.reduce((acc, l) => acc + l.custo, 0);

  res.json({
    gastos,
    vendas: {
      receita: arredondar(receita),
      custo: arredondar(custo),
      receita_liquida: arredondar(receita - custo),
      por_produto: porProduto
    },
    permite_relatorio_produtos: true
  });
});

module.exports = router;
