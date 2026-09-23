const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { cancelarAssinaturaNoGateway } = require('../services/pagamento');
const {
  planoPlataformaSchema,
  planoAtivoSchema,
  planoTesteSchema,
  empresaVencimentoSchema,
  empresaTrocarPlanoSchema,
  empresaTrocarVerticalSchema
} = require('../schemas');
const { limparCacheTrial } = require('../middleware/trialAuth');

const router = express.Router();

// --- Planos da plataforma (Grátis/Essencial/Profissional/Enterprise etc.) ---
// Antes desta rota, a única forma de mudar preço/limite/flag de um plano era escrever direto
// no banco pelo painel do Supabase — nenhuma rota do backend tocava planos_plataforma.

router.get('/super-admin/planos', async (req, res) => {
  const { data, error } = await supabase.from('planos_plataforma').select('*').order('preco_mensal', { ascending: true, nullsFirst: false });
  if (error) return res.status(500).json({ error: 'Erro ao buscar planos.' });
  res.json(data);
});

router.post('/super-admin/planos', validate(planoPlataformaSchema), async (req, res) => {
  const { data, error } = await supabase.from('planos_plataforma').insert(req.body).select('*').single();
  if (error) return res.status(500).json({ error: 'Erro ao criar plano.' });
  res.status(201).json(data);
});

router.put('/super-admin/planos/:id', validate(planoPlataformaSchema), async (req, res) => {
  const { data, error } = await supabase
    .from('planos_plataforma')
    .update(req.body)
    .eq('id', req.params.id)
    .select('*')
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao atualizar plano.' });
  if (!data) return res.status(404).json({ error: 'Plano não encontrado.' });
  res.json(data);
});

// Liga/desliga um plano: desligado, some da landing/cadastro e ninguém consegue contratar (nem
// pela API, ver routes/pagamentos.js e routes/empresasPublico.js). Empresas que já estão nele
// continuam normalmente. O Grátis não pode ser desligado: é o plano de destino de cancelamentos,
// chaves expiradas e testes, os crons dependem dele.
router.patch('/super-admin/planos/:id/ativo', validate(planoAtivoSchema), async (req, res) => {
  const { data: plano } = await supabase.from('planos_plataforma').select('id, nome').eq('id', req.params.id).maybeSingle();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado.' });
  if (plano.nome === 'Grátis' && !req.body.ativo) {
    return res.status(400).json({ error: 'O plano Grátis não pode ser desligado: ele é o plano de destino de cancelamentos e testes expirados.' });
  }

  const { data, error } = await supabase.from('planos_plataforma').update({ ativo: req.body.ativo }).eq('id', plano.id).select('*').single();
  if (error) return res.status(500).json({ error: 'Erro ao atualizar o plano.' });
  res.json(data);
});

// --- Área de teste de planos ---
// Aplica um plano (mesmo desligado/oculto, ex: um "Teste Completo" de R$0 com todos os
// recursos) numa empresa ESCOLHIDA por alguns dias, sem nunca expô-lo ao site. Guarda o plano
// anterior e, quando o prazo acaba, o cron (cron/assinaturas.js) devolve a empresa a ele.

router.get('/super-admin/testes-plano', async (req, res) => {
  const { data, error } = await supabase
    .from('empresas')
    .select('id, nome, slug, email, plano_teste_expira_em, plano_atual:plano_plataforma_id(id, nome), plano_anterior:plano_teste_anterior_id(id, nome)')
    .not('plano_teste_expira_em', 'is', null)
    .order('plano_teste_expira_em', { ascending: true });

  if (error) return res.status(500).json({ error: 'Erro ao buscar testes de plano.' });
  res.json(data);
});

router.post('/super-admin/testes-plano', validate(planoTesteSchema), async (req, res) => {
  const { empresa_id, plano_plataforma_id, dias } = req.body;

  const [{ data: plano }, { data: empresa }] = await Promise.all([
    supabase.from('planos_plataforma').select('id, nome').eq('id', plano_plataforma_id).maybeSingle(),
    supabase.from('empresas').select('id, nome, plano_plataforma_id, plano_teste_expira_em, plano_teste_anterior_id, gateway_subscription_id').eq('id', empresa_id).maybeSingle()
  ]);
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  // Empresa com cobrança recorrente própria não entra em teste: o teste trocaria o plano pago
  // dela por baixo da assinatura ativa no gateway.
  if (empresa.gateway_subscription_id) {
    return res.status(400).json({ error: 'Essa empresa tem assinatura paga ativa. Teste de plano é só pra contas sem cobrança recorrente.' });
  }

  // Testar de novo numa empresa que já está em teste mantém o plano ORIGINAL como retorno, não o
  // plano de teste anterior, senão ela ficaria presa num plano de teste ao expirar.
  const anteriorId = empresa.plano_teste_expira_em ? empresa.plano_teste_anterior_id : empresa.plano_plataforma_id;
  const expiraEm = new Date(Date.now() + dias * 86400000).toISOString();

  const { error } = await supabase
    .from('empresas')
    .update({
      plano_plataforma_id: plano.id,
      plano_plataforma_pendente_id: null,
      status_assinatura: 'ativa',
      plano_teste_anterior_id: anteriorId,
      plano_teste_expira_em: expiraEm
    })
    .eq('id', empresa.id);

  if (error) return res.status(500).json({ error: 'Erro ao aplicar o teste de plano.' });
  limparCacheTrial(empresa.id);
  res.json({
    success: true,
    message: `Plano ${plano.nome} aplicado em ${empresa.nome} até ${new Date(expiraEm).toLocaleDateString('pt-BR')}. Depois disso ela volta ao plano anterior.`,
    expira_em: expiraEm
  });
});

router.post('/super-admin/testes-plano/:empresaId/encerrar', async (req, res) => {
  const { data: empresa } = await supabase.from('empresas').select('id, plano_teste_anterior_id').eq('id', req.params.empresaId).maybeSingle();
  if (!empresa || !empresa.plano_teste_anterior_id) return res.status(404).json({ error: 'Essa empresa não está em teste de plano.' });

  const { error } = await supabase
    .from('empresas')
    .update({ plano_plataforma_id: empresa.plano_teste_anterior_id, plano_teste_anterior_id: null, plano_teste_expira_em: null })
    .eq('id', empresa.id);

  if (error) return res.status(500).json({ error: 'Erro ao encerrar o teste.' });
  limparCacheTrial(empresa.id);
  res.json({ success: true, message: 'Teste encerrado. A empresa voltou ao plano anterior.' });
});

// --- Antifraude de cadastro ---
// Grupos de empresas que compartilham e-mail (normalizado), telefone, CPF/CNPJ, nome ou IP. O
// cadastro novo já é BLOQUEADO em e-mail/telefone/documento repetidos (services/antifraude.js);
// aqui o admin vê o que passou (nomes iguais, IPs repetidos) e libera falsos positivos.

router.get('/super-admin/antifraude', async (req, res) => {
  const { data: registros, error } = await supabase
    .from('cadastro_empresa_registros')
    .select('id, empresa_id, nome_empresa, email_normalizado, telefone_normalizado, documento, nome_normalizado, ip, liberado_em, criado_em, empresa:empresa_id(id, slug, status_assinatura, plano:plano_plataforma_id(nome))')
    .order('criado_em', { ascending: false })
    .limit(2000);

  if (error) return res.status(500).json({ error: 'Erro ao buscar registros de antifraude.' });

  const CAMPOS = [['email_normalizado', 'email'], ['telefone_normalizado', 'telefone'], ['documento', 'documento'], ['nome_normalizado', 'nome'], ['ip', 'ip']];
  const grupos = [];
  for (const [coluna, rotulo] of CAMPOS) {
    const porValor = new Map();
    for (const r of registros) {
      if (!r[coluna] || r.liberado_em) continue;
      if (!porValor.has(r[coluna])) porValor.set(r[coluna], []);
      porValor.get(r[coluna]).push(r);
    }
    for (const [valor, lista] of porValor) {
      // Mesmo IP em 2 contas é comum (rede compartilhada), então só vira alerta a partir de 3.
      if (lista.length >= (coluna === 'ip' ? 3 : 2)) grupos.push({ campo: rotulo, valor, empresas: lista });
    }
  }

  res.json({ grupos, total_registros: registros.length });
});

// Falso positivo: o registro deixa de bloquear novos cadastros com esses dados.
router.post('/super-admin/antifraude/:id/liberar', async (req, res) => {
  const { error } = await supabase.from('cadastro_empresa_registros').update({ liberado_em: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao liberar o registro.' });
  res.json({ success: true });
});

// --- Empresas cadastradas na plataforma ---
// criado_em existe desde sql/2026_empresas_criado_em.sql — empresas cadastradas antes dessa
// migration ficaram com a data em que ela rodou (não dá pra recuperar a data real delas).

router.get('/super-admin/empresas', async (req, res) => {
  const { busca, status, plano_id } = req.query;

  let query = supabase
    .from('empresas')
    .select(`
      id, nome, slug, email, vertical, criado_em, excluida_em,
      status_assinatura, proxima_cobranca_em, cancelamento_agendado, chave_ativacao_expira_em,
      plano_plataforma_id, plano_plataforma:plano_plataforma_id(nome, preco_mensal, limite_profissionais, limite_agendamentos_mes),
      plano_plataforma_pendente_id, plano_plataforma_pendente:plano_plataforma_pendente_id(nome, preco_mensal)
    `)
    .order('criado_em', { ascending: false });

  // Remove vírgula/parênteses antes de interpolar no `.or()`: o PostgREST separa condições por
  // vírgula, então um valor como "x,plano_plataforma_id.eq.1" injetaria uma cláusula extra no filtro.
  if (busca) {
    const buscaSegura = String(busca).replace(/[,()]/g, '');
    query = query.or(`nome.ilike.%${buscaSegura}%,slug.ilike.%${buscaSegura}%,email.ilike.%${buscaSegura}%`);
  }
  // "excluida" não é um valor de status_assinatura (é a coluna separada excluida_em, ver
  // sql/2026_empresas_exclusao.sql) — filtra por ela em vez de tentar um eq normal.
  if (status === 'excluida') query = query.not('excluida_em', 'is', null);
  else if (status) query = query.eq('status_assinatura', status);
  if (plano_id) query = query.eq('plano_plataforma_id', plano_id);

  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: 'Erro ao buscar empresas.' });
  res.json(data);
});

// Detalhamento completo de uma empresa (aba "Empresas" -> "Ver detalhes"): junta os dados já
// usados na listagem com o consumo atual de barbeiros/agendamentos contra o limite do plano
// (mesma lógica de utils/limitesPlano.js, mas com o número, não só true/false) — calcular isso
// pra cada linha da listagem faria 2 queries extras por empresa, então fica só nesta rota,
// aberta sob demanda.
router.get('/super-admin/empresas/:id', async (req, res) => {
  const { data: empresa, error } = await supabase
    .from('empresas')
    .select(`
      id, nome, slug, email, vertical, cpf_cnpj, criado_em, excluida_em,
      status_assinatura, proxima_cobranca_em, cancelamento_agendado, gateway_subscription_id,
      chave_ativacao_expira_em, dominio_customizado, dominio_verificado,
      plano_plataforma_id, plano_plataforma:plano_plataforma_id(nome, preco_mensal, limite_profissionais, limite_agendamentos_mes, limite_admins),
      plano_plataforma_pendente_id, plano_plataforma_pendente:plano_plataforma_pendente_id(nome, preco_mensal)
    `)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar empresa.' });
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  const inicioMes = new Date();
  inicioMes.setUTCDate(1);
  const inicioMesISO = inicioMes.toISOString().slice(0, 10);

  const [{ count: totalBarbeiros }, { count: totalAgendamentosMes }, { count: totalClientes }, { count: totalUnidades }] = await Promise.all([
    supabase.from('barbeiros').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id),
    supabase.from('agendamentos').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id).gte('data_hora', `${inicioMesISO}T00:00:00`).neq('status', 'cancelado'),
    supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id),
    supabase.from('unidades').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa.id)
  ]);

  res.json({
    ...empresa,
    uso: {
      barbeiros: totalBarbeiros || 0,
      agendamentos_mes: totalAgendamentosMes || 0,
      clientes: totalClientes || 0,
      unidades: totalUnidades || 0
    }
  });
});

// Ajusta manualmente a data de próxima cobrança da assinatura da PLATAFORMA (dar carência,
// corrigir uma data errada, etc.) — não mexe em status_assinatura nem em cancelamento_agendado,
// só na data em si.
router.put('/super-admin/empresas/:id/vencimento', validate(empresaVencimentoSchema), async (req, res) => {
  const { error } = await supabase
    .from('empresas')
    .update({ proxima_cobranca_em: req.body.proxima_cobranca_em })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao atualizar a data de cobrança.' });
  res.json({ success: true, message: 'Data de próxima cobrança atualizada.' });
});

// Troca o plano da empresa na marra (suporte: cortesia, correção de um webhook que não aplicou o
// plano pendente, negociação fechada fora do sistema etc.) — mesma ideia de
// POST /super-admin/leads-enterprise/:id/ativar-empresa, mas pra qualquer plano, não só
// Enterprise. Cancela uma assinatura recorrente existente no Mercado Pago antes de trocar (best
// effort): sem isso, o cliente continuaria sendo cobrado no plano ANTIGO por uma recorrência que
// o admin não sabe mais que existe, já que o gateway_subscription_id é zerado a seguir.
//
// O backend nunca consegue cobrar o cartão da empresa na hora (isso só acontece pelo checkout do
// Mercado Pago, iniciado pela própria empresa em POST /admin/iniciar-upgrade) — então "gerar uma
// cobrança" aqui lança uma conta a receber (mesmo mecanismo manual de superAdminFinanceiro.js,
// com boleto/WhatsApp/baixa já prontos) em vez de tentar cobrar automaticamente. gerar_cobranca
// (default true) deixa desligar isso pra cortesia de verdade, onde nenhuma cobrança deve existir.
router.put('/super-admin/empresas/:id/plano', validate(empresaTrocarPlanoSchema), async (req, res) => {
  const { data: plano } = await supabase.from('planos_plataforma').select('id, nome, preco_mensal').eq('id', req.body.plano_plataforma_id).maybeSingle();
  if (!plano) return res.status(400).json({ error: 'Plano inválido.' });

  const { data: empresaAtual } = await supabase.from('empresas').select('nome, email, gateway_subscription_id').eq('id', req.params.id).maybeSingle();
  if (!empresaAtual) return res.status(404).json({ error: 'Empresa não encontrada.' });

  if (empresaAtual.gateway_subscription_id) {
    try {
      await cancelarAssinaturaNoGateway(empresaAtual.gateway_subscription_id);
    } catch (e) {
      console.error('Erro ao cancelar assinatura anterior no Mercado Pago (troca manual de plano pelo admin absoluto):', e);
    }
  }

  const { error } = await supabase
    .from('empresas')
    .update({
      plano_plataforma_id: plano.id,
      plano_plataforma_pendente_id: null,
      gateway_subscription_id: null,
      status_assinatura: 'ativa',
      cancelamento_agendado: false,
      // A recorrência antiga (se havia) já foi cancelada acima — sem ela, essa data ficaria
      // inerte (nenhum cron/webhook cobra sem gateway_subscription_id) e só confundiria o dono
      // da empresa na tela de Conta. A cobrança do novo plano, se houver, vira conta a receber
      // logo abaixo, que tem sua própria data prevista.
      proxima_cobranca_em: null,
      // Troca manual do admin absoluto é decisão explícita: encerra qualquer trial/teste em curso.
      trial_expira_em: null,
      plano_teste_expira_em: null,
      plano_teste_anterior_id: null
    })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao trocar o plano da empresa.' });
  limparCacheTrial(Number(req.params.id));

  let avisoCobranca = '';
  if (req.body.gerar_cobranca && Number(plano.preco_mensal) > 0) {
    const hoje = new Date().toISOString().slice(0, 10);
    const { error: errCobranca } = await supabase.from('contas_receber').insert({
      empresa_id: req.params.id,
      pagador_nome: empresaAtual.nome,
      pagador_email: empresaAtual.email || null,
      descricao: `Assinatura de plataforma - troca de plano para ${plano.nome}`,
      valor: plano.preco_mensal,
      competencia: `${hoje.slice(0, 7)}-01`,
      data_prevista: hoje
    });
    if (errCobranca) {
      console.error('Erro ao lançar conta a receber na troca de plano:', errCobranca);
      avisoCobranca = ' O plano foi trocado, mas não foi possível lançar a cobrança em Contas a Receber — lance manualmente.';
    } else {
      avisoCobranca = ' Cobrança lançada em Contas a Receber.';
    }
  }

  res.json({ success: true, message: `Plano da empresa atualizado.${avisoCobranca}` });
});

// Cancela qualquer recorrência ativa no Mercado Pago antes de suspender (mesmo cuidado da troca
// de plano e da exclusão acima): sem isso, a empresa continuaria sendo cobrada todo mês mesmo
// com o painel bloqueado, já que suspender só travava o login, nunca mexeu em gateway_subscription_id.
router.post('/super-admin/empresas/:id/suspender', async (req, res) => {
  const { data: empresa } = await supabase.from('empresas').select('gateway_subscription_id').eq('id', req.params.id).maybeSingle();
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  if (empresa.gateway_subscription_id) {
    try {
      await cancelarAssinaturaNoGateway(empresa.gateway_subscription_id);
    } catch (e) {
      console.error('Erro ao cancelar assinatura no Mercado Pago (suspensão de empresa pelo admin absoluto):', e);
    }
  }

  const { error } = await supabase
    .from('empresas')
    .update({ status_assinatura: 'suspensa', gateway_subscription_id: null, cancelamento_agendado: false })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao suspender empresa.' });
  res.json({ success: true, message: 'Empresa suspensa. O login do admin dela fica bloqueado e a cobrança recorrente (se havia) foi cancelada.' });
});

router.post('/super-admin/empresas/:id/reativar', async (req, res) => {
  const { error } = await supabase.from('empresas').update({ status_assinatura: 'ativa' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao reativar empresa.' });
  res.json({ success: true, message: 'Empresa reativada.' });
});

// Corrige o tipo de negócio de uma empresa cadastrada errada no self-service (ver comentário do
// schema em schemas/index.js). Não mexe em mais nada — layout, terminologia etc. da própria
// empresa já reagem ao campo `vertical` sozinhos, igual reagiriam se tivesse nascido certo.
router.put('/super-admin/empresas/:id/vertical', validate(empresaTrocarVerticalSchema), async (req, res) => {
  const { error } = await supabase.from('empresas').update({ vertical: req.body.vertical }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao trocar o tipo de negócio da empresa.' });
  res.json({ success: true, message: 'Tipo de negócio atualizado.' });
});

// Exclusão (soft delete, ver sql/2026_empresas_exclusao.sql): não apaga nada, só marca
// excluida_em e bloqueia login (POST /admin/login, ver routes/auth.js). Cancela qualquer
// recorrência ativa no Mercado Pago (mesmo cuidado da troca de plano acima, senão o dono
// continuaria sendo cobrado por uma conta que ele acha excluída) e libera o(s) registro(s) do
// antifraude dessa empresa (services/antifraude.js) — sem isso, excluir a empresa não bastaria
// pra liberar o e-mail/telefone/documento pra um novo cadastro, já que o antifraude sobrevive
// de propósito à exclusão da empresa.
router.post('/super-admin/empresas/:id/excluir', async (req, res) => {
  const { data: empresa } = await supabase.from('empresas').select('gateway_subscription_id').eq('id', req.params.id).maybeSingle();
  if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

  if (empresa.gateway_subscription_id) {
    try {
      await cancelarAssinaturaNoGateway(empresa.gateway_subscription_id);
    } catch (e) {
      console.error('Erro ao cancelar assinatura no Mercado Pago (exclusão de empresa pelo admin absoluto):', e);
    }
  }

  const { error } = await supabase
    .from('empresas')
    .update({
      excluida_em: new Date().toISOString(),
      status_assinatura: 'cancelada',
      cancelamento_agendado: false,
      gateway_subscription_id: null,
      plano_plataforma_pendente_id: null,
      trial_expira_em: null,
      plano_teste_expira_em: null,
      plano_teste_anterior_id: null
    })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: 'Erro ao excluir empresa.' });

  const { error: antifraudeError } = await supabase
    .from('cadastro_empresa_registros')
    .update({ liberado_em: new Date().toISOString() })
    .eq('empresa_id', req.params.id)
    .is('liberado_em', null);
  if (antifraudeError) console.error('Erro ao liberar antifraude na exclusão de empresa:', antifraudeError);

  limparCacheTrial(Number(req.params.id));
  res.json({ success: true, message: 'Empresa excluída. O e-mail dela já pode fazer um novo cadastro.' });
});

router.post('/super-admin/empresas/:id/restaurar', async (req, res) => {
  const { error } = await supabase.from('empresas').update({ excluida_em: null }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao restaurar empresa.' });
  res.json({ success: true, message: 'Empresa restaurada. Confira o plano e o status da assinatura dela.' });
});

// --- Métricas gerais da plataforma ---

// periodo=mes exige ano+mes (mes 0-indexado, igual Date do JS, mesmo padrão usado no filtro do
// AdminDashboard.js do admin de empresa); qualquer coisa diferente de 'mes' cai no ano inteiro.
// Sem período nenhum na query, assume o ano corrente — é o "filtro macro" da tela de Métricas.
function calcularPeriodo(query) {
  const hoje = new Date();
  const ano = Number(query.ano) || hoje.getUTCFullYear();

  if (query.periodo === 'mes') {
    const mes = query.mes !== undefined ? Number(query.mes) : hoje.getUTCMonth();
    return {
      tipo: 'mes',
      ano,
      mes,
      inicio: new Date(Date.UTC(ano, mes, 1)),
      fim: new Date(Date.UTC(ano, mes + 1, 0, 23, 59, 59, 999))
    };
  }

  return {
    tipo: 'ano',
    ano,
    inicio: new Date(Date.UTC(ano, 0, 1)),
    fim: new Date(Date.UTC(ano, 11, 31, 23, 59, 59, 999))
  };
}

router.get('/super-admin/metricas', async (req, res) => {
  const periodo = calcularPeriodo(req.query);

  const [{ data: empresas, error }, { data: cadastradasNoPeriodo, error: errCadastro }, { data: aReceberRows, error: errAReceber }] = await Promise.all([
    supabase.from('empresas').select('status_assinatura, plano_plataforma:plano_plataforma_id(nome, preco_mensal)'),
    supabase.from('empresas').select('id').gte('criado_em', periodo.inicio.toISOString()).lte('criado_em', periodo.fim.toISOString()),
    // "A receber no período": soma o preço dos planos pagos cuja PRÓXIMA cobrança cai dentro do
    // período — como o sistema só guarda a próxima data (não um calendário de cobranças
    // futuras), isso reflete uma única cobrança por empresa, não uma projeção de todo o ano.
    supabase.from('empresas').select('plano_plataforma:plano_plataforma_id(preco_mensal)').gte('proxima_cobranca_em', periodo.inicio.toISOString()).lte('proxima_cobranca_em', periodo.fim.toISOString())
  ]);

  if (error || errCadastro || errAReceber) return res.status(500).json({ error: 'Erro ao calcular métricas.' });

  const totalEmpresas = empresas.length;
  const porStatus = {};
  const porPlano = {};
  let mrr = 0;

  for (const e of empresas) {
    porStatus[e.status_assinatura || 'sem_status'] = (porStatus[e.status_assinatura || 'sem_status'] || 0) + 1;

    const nomePlano = e.plano_plataforma?.nome || 'Sem plano';
    porPlano[nomePlano] = (porPlano[nomePlano] || 0) + 1;

    // MRR só soma empresas com assinatura ativa e plano pago — trial/inadimplente/suspensa não
    // representam receita recorrente confirmada. É sempre um retrato de AGORA, não do período
    // filtrado (MRR não é uma métrica "de um mês passado").
    if (e.status_assinatura === 'ativa' && e.plano_plataforma?.preco_mensal > 0) {
      mrr += Number(e.plano_plataforma.preco_mensal);
    }
  }

  const aReceberNoPeriodo = (aReceberRows || []).reduce((soma, e) => soma + (e.plano_plataforma?.preco_mensal > 0 ? Number(e.plano_plataforma.preco_mensal) : 0), 0);

  res.json({
    periodo: { tipo: periodo.tipo, ano: periodo.ano, mes: periodo.mes },
    total_empresas: totalEmpresas,
    mrr: Number(mrr.toFixed(2)),
    empresas_por_status: porStatus,
    empresas_por_plano: porPlano,
    cadastradas_no_periodo: (cadastradasNoPeriodo || []).length,
    a_receber_no_periodo: Number(aReceberNoPeriodo.toFixed(2))
  });
});

module.exports = router;
