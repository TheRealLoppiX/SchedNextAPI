const express = require('express');
const bcrypt = require('bcrypt');

const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const { emailHtml } = require('../utils/emailTemplate');
const validate = require('../middleware/validate');
const verificarTokenCliente = require('../middleware/clienteAuth');
const {
  agendarSchema,
  encaixeSchema,
  finalizarEncaixeCompletoSchema,
  confirmarAgendamentoSchema,
  cancelarAgendamentoSchema,
  finalizarCheckoutSchema,
  agendarEncaixeSchema
} = require('../schemas');
const {
  limiteAgendamentosMesAtingido,
  confirmarLimiteAgendamentosOuDesfazer,
  permiteWhatsappBot
} = require('../utils/limitesPlano');
const { calcularValorComDescontoAssinante } = require('../utils/valorAssinante');
const { verificarEDispararPremioFidelidade } = require('../services/fidelidade');
const { enviarMensagem } = require('../services/whatsapp/provider');

const MENSAGEM_LIMITE_AGENDAMENTOS = 'Este estabelecimento atingiu o limite de agendamentos do mês. Peça para o administrador fazer upgrade de plano.';

const router = express.Router();

// verificarTokenCliente garante que o agendamento é criado em nome de quem está de fato
// logado (req.usuarioId). Antes, o usuario_id vinha direto do body, então qualquer chamador
// podia criar/"trancar" a agenda de outro cliente só sabendo o ID dele.
router.post('/agendar', verificarTokenCliente, validate(agendarSchema), async (req, res) => {
  const { barbeiro_id, empresa_slug, data_hora, servicos, unidade_id } = req.body;
  const usuario_id = req.usuarioId;

  // 1. EXTRAI APENAS A DATA (YYYY-MM-DD) PARA VALIDAR O DIA
  const dataApenas = data_hora.split(' ')[0];

  // 2. VERIFICA SE O USUÁRIO JÁ TEM AGENDAMENTO NO MESMO DIA (Ignora os cancelados)
  const { data: existentes, error: checkErr } = await supabase
    .from('agendamentos')
    .select('id')
    .eq('usuario_id', usuario_id)
    .gte('data_hora', `${dataApenas}T00:00:00`)
    .lte('data_hora', `${dataApenas}T23:59:59`)
    .neq('status', 'cancelado');

  if (checkErr) return res.status(500).json({ error: 'Erro ao validar duplicidade' });
  if (existentes.length > 0) {
    return res.status(400).json({ error: 'Você já possui um agendamento para este dia.' });
  }

  const { data: emp, error: empErr } = await supabase
    .from('empresas')
    .select('id, nome')
    .eq('slug', empresa_slug)
    .maybeSingle();

  if (empErr || !emp) return res.status(404).json({ error: 'Empresa não encontrada' });

  if (await limiteAgendamentosMesAtingido(emp.id)) {
    return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
  }

  const ids = servicos.map((s) => s.id);
  const { data: servicosInfo, error: servErr } = await supabase.from('servicos').select('id, duracao, valor').in('id', ids);

  if (servErr || !servicosInfo || servicosInfo.length === 0) {
    return res.status(400).json({ error: 'Serviços inválidos' });
  }

  const duracaoTotal = servicosInfo.reduce((acc, s) => acc + (s.duracao || 0), 0);
  // Desconta os serviços que já estão inclusos no plano de assinatura do cliente (se ele for
  // assinante) — antes isso somava o preço cheio de tudo, cobrando de novo o que já tinha sido
  // pago na mensalidade.
  const valorTotal = await calcularValorComDescontoAssinante(usuario_id, servicosInfo);

  const { data: novoAgendamento, error: insErr } = await supabase
    .from('agendamentos')
    .insert({
      usuario_id,
      barbeiro_id,
      empresa_id: emp.id,
      data_hora,
      duracao_total: duracaoTotal,
      valor_total: valorTotal,
      unidade_id: unidade_id || null
    })
    .select('id')
    .single();

  if (insErr) return res.status(500).json({ error: 'Erro no banco: ' + insErr.message });

  // Reconfere o limite logo após inserir (ver comentário em utils/limitesPlano.js). Cobre a
  // corrida em que dois agendamentos concorrentes passaram os dois pela checagem acima antes
  // de qualquer um deles existir no banco.
  if (!(await confirmarLimiteAgendamentosOuDesfazer(emp.id, novoAgendamento.id))) {
    return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
  }

  const vinculos = servicos.map((s) => ({ agendamento_id: novoAgendamento.id, servico_id: s.id }));
  const { error: vincErr } = await supabase.from('agendamento_servicos').insert(vinculos);
  if (vincErr) return res.status(500).json({ error: 'Erro ao vincular serviços' });

  const { data: usuario } = await supabase.from('usuarios').select('email, nome_completo, telefone').eq('id', usuario_id).maybeSingle();
  if (usuario) {
    const dataFormatada = new Date(data_hora).toLocaleString('pt-BR');
    transporter.sendMail({
      to: usuario.email,
      subject: 'Agendamento confirmado! - SchedNext',
      html: emailHtml({
        titulo: `Olá, ${usuario.nome_completo}!`,
        mensagemHtml: `
          <p style="margin: 0 0 4px;">Seu agendamento na <strong>${emp.nome}</strong> foi confirmado:</p>
          <p style="margin: 12px 0; font-size: 15px;"><strong>Data:</strong> ${dataFormatada}<br><strong>Valor:</strong> R$ ${valorTotal}</p>
        `
      })
    }).catch((mailErr) => console.error('Erro ao enviar e-mail de confirmação de agendamento:', mailErr));

    if (usuario.telefone && (await permiteWhatsappBot(emp.id))) {
      enviarMensagem(
        `55${usuario.telefone.replace(/\D/g, '')}`,
        `✅ Agendamento confirmado! ${emp.nome}, ${dataFormatada}. Valor: R$ ${valorTotal}.`
      ).catch((err) => console.error('Erro ao enviar WhatsApp de confirmação de agendamento:', err));
    }
  }

  res.json({ message: 'Agendamento criado!' });
});

// Rota para buscar estatísticas do Dashboard Admin
router.get('/admin/stats/:empresa_id', async (req, res) => {
  const empresa_id = req.empresaId;
  const { dataInicio, dataFim } = req.query;

  let query = supabase.from('agendamentos').select('id, status, data_hora').eq('empresa_id', empresa_id);
  if (dataInicio) query = query.gte('data_hora', `${dataInicio}T00:00:00`);
  if (dataFim) query = query.lte('data_hora', `${dataFim}T23:59:59`);

  const { data: agendamentos, error } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar estatísticas' });

  const agora = new Date();
  const dezMinAtras = new Date(agora.getTime() - 10 * 60000);

  const total = agendamentos.length;
  // 'finalizado' nunca foi um valor válido do ENUM real de status (ver database-schema.md).
  // Os filtros originais que incluíam 'finalizado' foram reduzidos a só 'concluido'/'cancelado'.
  const concluidos = agendamentos.filter((a) => a.status === 'concluido').length;
  const cancelados = agendamentos.filter((a) => a.status === 'cancelado').length;
  const nao_compareceu = agendamentos.filter(
    (a) => a.status !== 'cancelado' && a.status !== 'concluido' && new Date(a.data_hora) < dezMinAtras
  ).length;

  let clientesQuery = supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('empresa_id', empresa_id).eq('tipo', 'cliente');
  if (dataInicio) clientesQuery = clientesQuery.gte('data_cadastro', `${dataInicio}T00:00:00`);
  if (dataFim) clientesQuery = clientesQuery.lte('data_cadastro', `${dataFim}T23:59:59`);

  const { count: novos_clientes } = await clientesQuery;

  const taxa_conclusao = total > 0 ? ((concluidos / total) * 100).toFixed(1) : 0;
  const taxa_cancelamento = total > 0 ? ((cancelados / total) * 100).toFixed(1) : 0;
  const taxa_nao_compareceu = total > 0 ? ((nao_compareceu / total) * 100).toFixed(1) : 0;

  res.json({
    total,
    concluidos,
    cancelados,
    nao_compareceu,
    novos_clientes: novos_clientes || 0,
    taxa_conclusao,
    taxa_cancelamento,
    taxa_nao_compareceu
  });
});

router.post('/admin/encaixe', validate(encaixeSchema), async (req, res) => {
  const { barbeiro_id, cliente_nome, data_hora, servicos_ids } = req.body;
  const empresa_id = req.empresaId;

  const { data: barbeiro } = await supabase.from('barbeiros').select('empresa_id').eq('id', barbeiro_id).maybeSingle();
  if (!barbeiro || barbeiro.empresa_id !== empresa_id) return res.status(404).json({ error: 'Profissional não encontrado.' });

  const agora = new Date();
  const dataTentativa = new Date(data_hora);

  if (dataTentativa < agora) {
    return res.status(400).json({ error: 'Bloqueado! Não é possível fazer encaixe em horários que já passaram.' });
  }

  if (await limiteAgendamentosMesAtingido(empresa_id)) {
    return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
  }

  const { data: servicosInfo, error: servErr } = await supabase.from('servicos').select('duracao, valor').in('id', servicos_ids);
  if (servErr) {
    console.error('Erro ao somar serviços:', servErr);
    return res.status(500).json({ error: 'Erro ao processar valores dos serviços.' });
  }

  const duracaoTotal = (servicosInfo || []).reduce((acc, s) => acc + (s.duracao || 0), 0);
  const valorTotal = (servicosInfo || []).reduce((acc, s) => acc + Number(s.valor || 0), 0);

  // A coluna `observacoes` nunca existiu no banco real (ver database-schema.md); a versão
  // MySQL desta rota já estava quebrada por isso. Corrigido para usar `cliente_nome`, igual à
  // rota irmã /admin/agendar-encaixe.
  const { data: novoAgendamento, error: agError } = await supabase
    .from('agendamentos')
    .insert({
      usuario_id: null,
      barbeiro_id,
      empresa_id,
      data_hora,
      duracao_total: duracaoTotal,
      valor_total: valorTotal,
      status: 'confirmado',
      cliente_nome: cliente_nome
    })
    .select('id')
    .single();

  if (agError) {
    console.error('Erro ao criar agendamento:', agError);
    return res.status(500).json({ error: 'Erro ao salvar o agendamento.' });
  }

  if (!(await confirmarLimiteAgendamentosOuDesfazer(empresa_id, novoAgendamento.id))) {
    return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
  }

  const vinculos = servicos_ids.map((servico_id) => ({ agendamento_id: novoAgendamento.id, servico_id }));
  const { error: vincError } = await supabase.from('agendamento_servicos').insert(vinculos);

  if (vincError) {
    console.error('Erro ao vincular serviços:', vincError);
    return res.status(500).json({ error: 'Agendamento criado, mas falhou ao vincular serviços.' });
  }

  res.json({ success: true, message: 'Encaixe e serviços registrados com sucesso!', id: novoAgendamento.id });
});

// BUSCAR CLIENTES (Para a flag de pesquisa)
router.get('/admin/buscar-clientes', async (req, res) => {
  // Remove vírgula/parênteses antes de interpolar no `.or()`: o PostgREST separa condições por
  // vírgula, então um valor como "x,telefone.neq.0" injetaria uma cláusula extra no filtro.
  const q = String(req.query.q || '').replace(/[,()]/g, '');

  // Sem o filtro por empresa_id, isso vazava clientes de QUALQUER tenant pra qualquer admin
  // autenticado; a busca nunca era restrita à empresa de quem estava logado.
  const { data, error } = await supabase
    .from('usuarios')
    .select('id, nome_completo, email, telefone')
    .eq('tipo', 'cliente')
    .eq('empresa_id', req.empresaId)
    .or(`nome_completo.ilike.%${q}%,telefone.ilike.%${q}%`)
    .limit(10);

  if (error) {
    console.error('Erro buscar-clientes:', error);
    return res.status(500).json({ error: 'Erro na busca' });
  }

  res.json(
    data.map((u) => ({
      id: u.id,
      nome: u.nome_completo || 'Sem Nome',
      email: u.email,
      telefone: u.telefone || ''
    }))
  );
});

// ENCAIXE E CADASTRO COMPLETO (A rota "Matadora")
router.post('/admin/finalizar-encaixe-completo', validate(finalizarEncaixeCompletoSchema), async (req, res) => {
  const { barbeiro_id, data_hora, servicos_ids, isNovoCliente, clienteData } = req.body;
  const empresa_id = req.empresaId;

  try {
    if (await limiteAgendamentosMesAtingido(empresa_id)) {
      return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
    }

    let finalUserId;

    if (isNovoCliente) {
      if (!clienteData.email || !clienteData.senha) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
      }

      const senhaHash = await bcrypt.hash(clienteData.senha, 10);

      // Inserindo com 'ativo = true' para não pedir confirmação de email
      const { data: novoUsuario, error: userErr } = await supabase
        .from('usuarios')
        .insert({
          nome_completo: clienteData.nome_completo || null,
          email: clienteData.email || null,
          senha: senhaHash,
          telefone: clienteData.telefone || null,
          data_nascimento: clienteData.data_nascimento || null,
          empresa_id,
          ativo: true
        })
        .select('id')
        .single();

      if (userErr) throw userErr;
      finalUserId = novoUsuario.id;
    } else {
      // Cliente existente: confere que pertence a esta empresa antes de vincular o
      // agendamento a ele. Sem isso, um admin podia atender "em nome" de um cliente de
      // outra empresa só passando o ID.
      const { data: clienteExistente } = await supabase
        .from('usuarios')
        .select('id')
        .eq('id', clienteData.id)
        .eq('empresa_id', empresa_id)
        .maybeSingle();
      if (!clienteExistente) return res.status(404).json({ error: 'Cliente não encontrado.' });
      finalUserId = clienteExistente.id;
    }

    const { data: novoAgendamento, error: agError } = await supabase
      .from('agendamentos')
      .insert({
        usuario_id: finalUserId,
        barbeiro_id,
        empresa_id,
        data_hora,
        status: 'confirmado',
        lembrete_1h_enviado: false
      })
      .select('id')
      .single();

    if (agError) throw agError;

    if (!(await confirmarLimiteAgendamentosOuDesfazer(empresa_id, novoAgendamento.id))) {
      return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
    }

    if (servicos_ids && servicos_ids.length > 0) {
      const vinculos = servicos_ids.map((srvId) => ({ agendamento_id: novoAgendamento.id, servico_id: srvId }));
      const { error: vincError } = await supabase.from('agendamento_servicos').insert(vinculos);
      if (vincError) throw vincError;
    }

    res.json({ success: true, message: 'Encaixe realizado com sucesso!' });
  } catch (error) {
    console.error('DETALHE DO ERRO NO SERVIDOR:', error);
    res.status(500).json({ error: 'Erro interno: ' + error.message });
  }
});

// Rota para Confirmar Agendamento
router.post('/admin/confirmar-agendamento', validate(confirmarAgendamentoSchema), async (req, res) => {
  const { agendamento_id } = req.body;
  const { data, error } = await supabase
    .from('agendamentos')
    .update({ status: 'confirmado' })
    .eq('id', agendamento_id)
    .eq('empresa_id', req.empresaId)
    .select('id');
  if (error) return res.status(500).json(error);
  if (!data || data.length === 0) return res.status(404).json({ error: 'Agendamento não encontrado.' });
  res.json({ success: true });
});

router.post('/admin/cancelar-agendamento', validate(cancelarAgendamentoSchema), async (req, res) => {
  const { agendamento_id, justificativa, enviadoPor } = req.body;

  if (!agendamento_id) return res.status(400).json({ error: 'ID ausente' });

  // 1. Primeiro cancelamos no banco para garantir que a agenda seja liberada. O filtro por
  // empresa_id evita que um admin de outra empresa cancele um agendamento que não é dele.
  const { data: cancelado, error: updError } = await supabase
    .from('agendamentos')
    .update({ status: 'cancelado', justificativa_cancelamento: justificativa, cancelado_por: enviadoPor })
    .eq('id', agendamento_id)
    .eq('empresa_id', req.empresaId)
    .select('id');

  if (!updError && (!cancelado || cancelado.length === 0)) {
    return res.status(404).json({ error: 'Agendamento não encontrado.' });
  }

  if (updError) {
    console.error('Erro no Update:', updError);
    return res.status(500).json({ error: 'Erro ao atualizar status.' });
  }

  // 2. Buscamos os dados do USUÁRIO vinculado (se existir)
  const { data: agendamento } = await supabase
    .from('agendamentos')
    .select('data_hora, usuarios(email, nome_completo, telefone)')
    .eq('id', agendamento_id)
    .maybeSingle();

  if (!agendamento || !agendamento.usuarios) {
    return res.json({ message: 'Cancelado com sucesso, mas o usuário não foi localizado para envio de e-mail.' });
  }

  // ATENÇÃO: agendamento.data_hora vem do banco com rótulo UTC (+00), mas os números gravados
  // já são o horário de parede pretendido (sem conversão real de fuso). Usar toLocaleString
  // aqui faria uma conversão de fuso de verdade e mostraria 3h a menos. Extraímos os
  // componentes com os getters UTC, que pegam exatamente os números gravados.
  const dhAg = new Date(agendamento.data_hora);
  const dataHora = `${String(dhAg.getUTCDate()).padStart(2, '0')}/${String(dhAg.getUTCMonth() + 1).padStart(2, '0')}/${dhAg.getUTCFullYear()} ${String(dhAg.getUTCHours()).padStart(2, '0')}:${String(dhAg.getUTCMinutes()).padStart(2, '0')}`;

  const mailOptions = {
    to: agendamento.usuarios.email,
    subject: 'Seu agendamento foi cancelado - SchedNext',
    html: emailHtml({
      titulo: `Olá, ${agendamento.usuarios.nome_completo}!`,
      mensagemHtml: `
        <p style="margin: 0 0 4px;">Infelizmente, seu agendamento para <strong>${dataHora}</strong> foi cancelado.</p>
        <p style="margin: 12px 0;"><strong>Motivo:</strong> ${justificativa}</p>
        <p style="margin: 0; color: #666; font-size: 13px;">Pedimos desculpas pelo transtorno. Você pode fazer uma nova reserva pelo aplicativo.</p>
      `
    })
  };

  if (agendamento.usuarios.telefone && (await permiteWhatsappBot(req.empresaId))) {
    enviarMensagem(
      `55${agendamento.usuarios.telefone.replace(/\D/g, '')}`,
      `Seu agendamento para ${dataHora} foi cancelado. Motivo: ${justificativa}. Você pode fazer uma nova reserva quando quiser.`
    ).catch((err) => console.error('Erro ao enviar WhatsApp de cancelamento:', err));
  }

  transporter.sendMail(mailOptions, (error) => {
    if (error) {
      console.error('Erro ao enviar e-mail (Gmail):', error);
      return res.json({ message: 'Cancelado no banco, mas o e-mail falhou (verifique a senha de app do Gmail).' });
    }
    res.json({ message: 'Cancelado com sucesso e cliente avisado por e-mail!' });
  });
});

// ROTA DE CHECKOUT (Para finalizar o atendimento e receber o pagamento)
router.post('/admin/finalizar-servico-checkout', validate(finalizarCheckoutSchema), async (req, res) => {
  const { agendamento_id, produtos_vendidos, servicos_adicionais, forma_pagamento } = req.body;

  if (!agendamento_id) {
    return res.status(400).json({ error: 'ID do agendamento é obrigatório.' });
  }

  try {
    // 1. Busca o valor base e a empresa já salvos no agendamento
    const { data: agAtual, error: agErr } = await supabase
      .from('agendamentos')
      .select('valor_total, empresa_id, usuario_id')
      .eq('id', agendamento_id)
      .maybeSingle();
    if (agErr) throw agErr;
    if (!agAtual || agAtual.empresa_id !== req.empresaId) {
      return res.status(404).json({ error: 'Agendamento não encontrado.' });
    }

    // Recalcula o valor base a partir dos serviços de fato vinculados ao agendamento e do
    // status de assinatura ATUAL do cliente, em vez de confiar cegamente no valor_total gravado
    // na criação (que já podia ter sido calculado sem considerar desconto de assinatura, ou
    // ficar desatualizado se o cliente virou assinante — ou deixou de ser — depois de agendar).
    // Ver bug documentado: estava cobrando o valor cheio de serviços já inclusos no plano.
    const { data: servicosVinculados } = await supabase
      .from('agendamento_servicos')
      .select('servico_id, servicos(id, valor)')
      .eq('agendamento_id', agendamento_id);

    let valorBase;
    if (servicosVinculados && servicosVinculados.length > 0) {
      const servicosParaCalculo = servicosVinculados
        .filter((v) => v.servicos)
        .map((v) => ({ id: v.servico_id, valor: v.servicos.valor }));
      valorBase = await calcularValorComDescontoAssinante(agAtual.usuario_id, servicosParaCalculo);
    } else {
      // Agendamentos sem serviço vinculado (ex: encaixe legado que só grava valor_total direto)
      // caem no valor gravado, não tem como recalcular sem saber quais serviços foram feitos.
      valorBase = parseFloat(agAtual?.valor_total || 0);
    }

    // 2. Soma os serviços adicionais escolhidos no PDV. O preço vem do banco (tabela
    // `servicos`), nunca do valor que o cliente/admin mandou no body: senão uma requisição
    // forjada podia fechar a conta por qualquer valor, incluindo 0.
    const idsServicosAdicionais = (servicos_adicionais || []).map((s) => s.id).filter(Boolean);
    let precoPorServico = {};
    if (idsServicosAdicionais.length > 0) {
      const { data: servicosReais } = await supabase
        .from('servicos')
        .select('id, valor')
        .in('id', idsServicosAdicionais)
        .eq('empresa_id', agAtual.empresa_id);
      precoPorServico = Object.fromEntries((servicosReais || []).map((s) => [s.id, Number(s.valor) || 0]));
    }
    const valorAdicionais = (servicos_adicionais || []).reduce((acc, s) => acc + (precoPorServico[s.id] || 0), 0);

    // 3. Soma os produtos vendidos. Mesmo raciocínio: preço vem do banco (`produtos`), não
    // do body. Só a quantidade é informação legítima do PDV.
    let valorProdutos = 0;
    if (produtos_vendidos && produtos_vendidos.length > 0) {
      const idsProdutos = produtos_vendidos.map((p) => p.id).filter(Boolean);
      const { data: produtosReais } = await supabase
        .from('produtos')
        .select('id, valor')
        .in('id', idsProdutos)
        .eq('empresa_id', agAtual.empresa_id);
      const precoPorProduto = Object.fromEntries((produtosReais || []).map((p) => [p.id, Number(p.valor) || 0]));
      valorProdutos = produtos_vendidos.reduce((acc, p) => {
        const qtd = parseInt(p.quantidade || 1, 10);
        return acc + (precoPorProduto[p.id] || 0) * qtd;
      }, 0);
    }

    const valorFinal = valorBase + valorAdicionais + valorProdutos;

    // 4. Atualiza o agendamento para concluído com o valor total final. forma_pagamento é só
    // registro informativo (dinheiro/crédito/débito/pix) pro relatório de faturamento — não gera
    // cobrança nenhuma de verdade, isso depende de gateway configurado por fora (ver PENDENCIAS.md).
    const { error: updError } = await supabase
      .from('agendamentos')
      .update({ status: 'concluido', valor_total: valorFinal, forma_pagamento: forma_pagamento || null })
      .eq('id', agendamento_id)
      .eq('empresa_id', req.empresaId);
    if (updError) throw updError;

    // 5. Baixa de estoque dos produtos vendidos
    if (produtos_vendidos && produtos_vendidos.length > 0) {
      for (const produto of produtos_vendidos) {
        try {
          const { data: produtoAtual } = await supabase
            .from('produtos')
            .select('quantidade')
            .eq('id', produto.id)
            .eq('empresa_id', agAtual.empresa_id)
            .maybeSingle();

          if (produtoAtual) {
            await supabase
              .from('produtos')
              .update({ quantidade: produtoAtual.quantidade - produto.quantidade })
              .eq('id', produto.id)
              .eq('empresa_id', agAtual.empresa_id);
            console.log(`Baixa de estoque: Produto ID ${produto.id} | Qtd: -${produto.quantidade}`);
          }
        } catch (errEstoque) {
          console.error('Erro ao baixar estoque:', errEstoque);
        }
      }
    }

    // 6. Registra serviços adicionais na tabela de histórico
    if (servicos_adicionais && servicos_adicionais.length > 0) {
      const vinculos = servicos_adicionais.map((s) => ({ agendamento_id: Number(agendamento_id), servico_id: s.id }));
      // Insere sem preco_na_epoca pois a coluna não existe no banco real (ver database-schema.md)
      const { error: vincError } = await supabase.from('agendamento_servicos').insert(vinculos);
      if (vincError) throw vincError;
    }

    res.json({ success: true, message: 'Atendimento finalizado!', valor_final: valorFinal });

    // Disparado depois da resposta: checagem de fidelidade não deve atrasar nem quebrar o
    // fechamento de caixa se o e-mail/WhatsApp falhar por qualquer motivo.
    verificarEDispararPremioFidelidade(agAtual.usuario_id, req.empresaId);
  } catch (err) {
    console.error('Erro no checkout:', err);
    res.status(500).json({ error: err.message || 'Erro ao processar o fechamento do caixa.' });
  }
});

// GET AGENDAMENTOS - busca nome dos serviços via join (a.servicos não existe no banco)
router.get('/admin/agendamentos/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('agendamentos')
    .select(
      'id, data_hora, status, valor_total, duracao_total, cliente_nome, usuarios(nome_completo, telefone), barbeiros(id, nome), agendamento_servicos(servicos(nome))'
    )
    .eq('empresa_id', req.empresaId)
    .order('data_hora', { ascending: false });

  if (error) {
    console.error('Erro admin/agendamentos:', error);
    return res.status(500).json([]);
  }

  const formatado = data.map((row) => {
    const dh = new Date(row.data_hora);
    const nomesServicos = (row.agendamento_servicos || [])
      .map((as) => as.servicos && as.servicos.nome)
      .filter(Boolean)
      .join(' + ');

    return {
      id: row.id,
      data: dh.toISOString().slice(0, 10),
      hora: dh.toISOString().slice(11, 16),
      status: row.status,
      valor_total: row.valor_total,
      duracao: row.duracao_total,
      servico_nome: nomesServicos || 'Serviço',
      servicos: nomesServicos || 'Serviço',
      cliente_nome: (row.usuarios && row.usuarios.nome_completo) || row.cliente_nome || 'Cliente Avulso',
      cliente_telefone: (row.usuarios && row.usuarios.telefone) || '',
      barbeiro_nome: row.barbeiros ? row.barbeiros.nome : null,
      barbeiro_id: row.barbeiros ? row.barbeiros.id : null
    };
  });

  res.json(formatado);
});

router.post('/admin/agendar-encaixe', validate(agendarEncaixeSchema), async (req, res) => {
  const { barbeiro_id, usuario_id, data_hora, servicos, cliente_nome } = req.body;
  const empresa_id = req.empresaId;

  try {
    if (await limiteAgendamentosMesAtingido(empresa_id)) {
      return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
    }

    // Desconta os serviços já inclusos no plano de assinatura do cliente, se ele for assinante
    // (ver bug histórico documentado em PENDENCIAS.md — cobrava o valor cheio mesmo do que já
    // estava pago na mensalidade).
    const valorTotal = servicos && servicos.length > 0
      ? await calcularValorComDescontoAssinante(
          usuario_id,
          servicos.map((s) => ({ id: s.id, valor: parseFloat(String(s.preco || s.valor || '0').replace(',', '.')) }))
        )
      : 0;

    const duracaoTotal = servicos && servicos.length > 0
      ? servicos.reduce((acc, s) => acc + parseInt(s.duracao || 30, 10), 0)
      : 30;

    // Se não tem usuario_id, usa o nome do cliente avulso; senão busca o nome do usuário
    // vinculado, já conferindo que ele pertence a esta empresa.
    let nomeClienteAvulso = null;
    if (!usuario_id && cliente_nome) {
      nomeClienteAvulso = cliente_nome;
    } else if (usuario_id) {
      const { data: uRow } = await supabase.from('usuarios').select('nome_completo').eq('id', usuario_id).eq('empresa_id', empresa_id).maybeSingle();
      if (!uRow) return res.status(404).json({ error: 'Cliente não encontrado.' });
      nomeClienteAvulso = uRow.nome_completo;
    }

    // Nota: duracao_total e cliente_nome existem de verdade no banco (confirmado no dump real),
    // então não precisamos mais do fallback ER_BAD_FIELD_ERROR que a versão MySQL tinha.
    const { data: novoAgendamento, error: insertErr } = await supabase
      .from('agendamentos')
      .insert({
        usuario_id,
        empresa_id,
        barbeiro_id,
        data_hora,
        status: 'confirmado',
        valor_total: valorTotal,
        duracao_total: duracaoTotal,
        cliente_nome: nomeClienteAvulso
      })
      .select('id')
      .single();

    if (insertErr) throw insertErr;

    if (!(await confirmarLimiteAgendamentosOuDesfazer(empresa_id, novoAgendamento.id))) {
      return res.status(403).json({ error: MENSAGEM_LIMITE_AGENDAMENTOS });
    }

    // Nota: preco_na_epoca não existe no banco real (ver database-schema.md), então nunca a inserimos.
    if (servicos && servicos.length > 0) {
      const vinculos = servicos.map((s) => ({ agendamento_id: novoAgendamento.id, servico_id: s.id }));
      const { error: vincError } = await supabase.from('agendamento_servicos').insert(vinculos);
      if (vincError) throw vincError;
    }

    res.json({ success: true, id: novoAgendamento.id });
  } catch (err) {
    console.error('Erro em agendar-encaixe:', err.code, err.message);
    res.status(500).json({ error: err.message || 'Erro ao salvar agendamento no banco.' });
  }
});

// Retorna usuario_id, servicos do agendamento e info de assinatura (queries separadas para evitar produto cartesiano)
router.get('/admin/agendamento-usuario/:id', async (req, res) => {
  try {
    const { data: ag } = await supabase
      .from('agendamentos')
      .select('usuario_id, valor_total, empresa_id, usuarios(assinante, plano_id)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!ag || ag.empresa_id !== req.empresaId) {
      return res.json({ usuario_id: null, assinante: false, servicos_ids: [], servicos_agendados_ids: [] });
    }

    const { data: asvRows } = await supabase
      .from('agendamento_servicos')
      .select('servico_id')
      .eq('agendamento_id', req.params.id);

    const servicosAgendadosIds = [...new Set((asvRows || []).map((r) => r.servico_id))];

    const usuario = ag.usuarios || {};
    if (!usuario.assinante || !usuario.plano_id) {
      return res.json({
        usuario_id: ag.usuario_id,
        assinante: false,
        servicos_ids: [],
        servicos_agendados_ids: servicosAgendadosIds
      });
    }

    const { data: psRows } = await supabase
      .from('plano_servicos')
      .select('servico_id')
      .eq('plano_id', usuario.plano_id);

    const servicosPlanoIds = [...new Set((psRows || []).map((r) => r.servico_id))];

    res.json({
      usuario_id: ag.usuario_id,
      assinante: true,
      plano_id: usuario.plano_id,
      servicos_ids: servicosPlanoIds,
      servicos_agendados_ids: servicosAgendadosIds
    });
  } catch (err) {
    console.error('Erro agendamento-usuario:', err);
    res.json({ usuario_id: null, assinante: false, servicos_ids: [], servicos_agendados_ids: [] });
  }
});

module.exports = router;
