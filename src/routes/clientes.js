const express = require('express');
const bcrypt = require('bcrypt');

const supabase = require('../config/supabase');
const transporter = require('../config/mailer');
const validate = require('../middleware/validate');
const { clienteRapidoSchema, clienteAtualizarSchema, clienteAssinanteSchema, clienteFollowupSchema } = require('../schemas');

const router = express.Router();

router.get('/admin/clientes/:empresaId', async (req, res) => {
  const { data: clientes, error } = await supabase
    .from('usuarios')
    .select('id, nome_completo, email, telefone, data_nascimento, assinante, assinante_desde, notas, data_cadastro')
    .eq('empresa_id', req.empresaId)
    .eq('tipo', 'cliente')
    .order('nome_completo', { ascending: true });

  if (error) { console.error('Erro admin/clientes:', error); return res.status(500).json([]); }

  const ids = clientes.map((c) => c.id);
  let agendamentosPorCliente = {};

  if (ids.length > 0) {
    // O SQL original filtrava status IN ('concluido', 'finalizado'), mas 'finalizado'
    // nunca foi um valor válido do ENUM real (ver database-schema.md); mantemos só 'concluido'.
    const { data: agendamentos, error: errAg } = await supabase
      .from('agendamentos')
      .select('usuario_id, data_hora')
      .in('usuario_id', ids)
      .eq('status', 'concluido');

    if (errAg) { console.error('Erro admin/clientes:', errAg); return res.status(500).json([]); }

    const agora = new Date();
    const mesAtual = agora.getMonth();
    const anoAtual = agora.getFullYear();

    agendamentosPorCliente = agendamentos.reduce((acc, a) => {
      const dh = new Date(a.data_hora);
      if (!acc[a.usuario_id]) acc[a.usuario_id] = { mes: 0, ano: 0, ultimo: null };
      const entry = acc[a.usuario_id];
      if (dh.getFullYear() === anoAtual) {
        entry.ano += 1;
        if (dh.getMonth() === mesAtual) entry.mes += 1;
      }
      if (!entry.ultimo || dh > entry.ultimo) entry.ultimo = dh;
      return acc;
    }, {});
  }

  const formatado = clientes.map((c) => {
    const ag = agendamentosPorCliente[c.id] || { mes: 0, ano: 0, ultimo: null };
    return {
      ...c,
      agendamentos_mes: ag.mes,
      agendamentos_ano: ag.ano,
      ultimo_agendamento: ag.ultimo ? ag.ultimo.toISOString() : null
    };
  });

  res.json(formatado);
});

router.put('/admin/clientes/:id', validate(clienteAtualizarSchema), async (req, res) => {
  const { id } = req.params;
  const { nome_completo, telefone, email, data_nascimento, notas } = req.body;

  const { data, error } = await supabase
    .from('usuarios')
    .update({ nome_completo, telefone, email, data_nascimento: data_nascimento || null, notas: notas || null })
    .eq('id', id)
    .eq('empresa_id', req.empresaId)
    .eq('tipo', 'cliente')
    .select('id');

  if (error) { console.error('Erro update cliente:', error); return res.status(500).json({ error: error.message }); }
  if (!data || data.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json({ success: true });
});

router.put('/admin/clientes/:id/assinante', validate(clienteAssinanteSchema), async (req, res) => {
  const { id } = req.params;
  const { assinante } = req.body;
  const dataAssinante = assinante ? new Date().toISOString().split('T')[0] : null;

  const { data, error } = await supabase
    .from('usuarios')
    .update({ assinante: !!assinante, assinante_desde: dataAssinante })
    .eq('id', id)
    .eq('empresa_id', req.empresaId)
    .eq('tipo', 'cliente')
    .select('id');

  if (error) { console.error('Erro assinante:', error); return res.status(500).json({ error: error.message }); }
  if (!data || data.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json({ success: true });
});

router.delete('/admin/clientes/:id', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('usuarios')
    .delete()
    .eq('id', id)
    .eq('empresa_id', req.empresaId)
    .eq('tipo', 'cliente')
    .select('id');

  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Cliente nao encontrado.' });
  res.json({ success: true });
});

router.post('/admin/clientes/followup', validate(clienteFollowupSchema), async (req, res) => {
  const { cliente_id, tipo } = req.body;
  const empresa_id = req.empresaId;
  try {
    const { data: cliente } = await supabase
      .from('usuarios')
      .select('nome_completo, email')
      .eq('id', cliente_id)
      .eq('empresa_id', empresa_id)
      .maybeSingle();

    if (!cliente) return res.status(404).json({ error: 'Cliente nao encontrado.' });

    const { data: empresa } = await supabase.from('empresas').select('nome').eq('id', empresa_id).maybeSingle();
    const nomeEmpresa = empresa?.nome || 'Seu estabelecimento';
    const primeiroNome = (cliente.nome_completo || '').split(' ')[0];

    let assunto, corpo;
    if (tipo === 'saudade') {
      assunto = nomeEmpresa + ' sente sua falta, ' + primeiroNome + '!';
      corpo = '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;color:#333"><h2>Ola, ' + primeiroNome + '!</h2><p>Faz um tempo que voce nao aparece por aqui e sentimos a sua falta!</p><p>Que tal agendar um horario? Estamos te esperando.</p><p style="margin-top:30px;color:#666">Com carinho,<br><strong>' + nomeEmpresa + '</strong></p></div>';
    } else {
      assunto = 'Feliz Aniversario, ' + primeiroNome + '!';
      corpo = '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;color:#333"><h2>Feliz Aniversario, ' + primeiroNome + '!</h2><p>Hoje e o seu dia especial e a equipe da <strong>' + nomeEmpresa + '</strong> veio te desejar tudo de melhor!</p><p>Voce merece se sentir incrivel hoje. Que tal comemorar com um visual novo?</p><p style="margin-top:30px;color:#666">Com muito carinho,<br><strong>' + nomeEmpresa + '</strong></p></div>';
    }

    await transporter.sendMail({
      from: '"Barbearia" <barberariateste@gmail.com>',
      to: cliente.email,
      subject: assunto,
      html: corpo
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Erro followup:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/clientes/rapido', validate(clienteRapidoSchema), async (req, res) => {
  const { nome, email, senha, tel, nasc } = req.body;
  const empresa_id = req.empresaId;

  try {
    const salt = await bcrypt.genSalt(10);
    const senhaHash = await bcrypt.hash(senha, salt);

    const telLimpo = tel.replace(/\D/g, '');
    const valNasc = nasc && nasc.trim() !== '' ? nasc : null;
    const emailLimpo = email.trim().toLowerCase();

    // Verifica duplicata por email apenas (telefone pode ter formatos diferentes no banco)
    const { data: jaExistePorEmail } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', emailLimpo)
      .maybeSingle();

    if (jaExistePorEmail) {
      return res.status(400).json({ error: 'Já existe um cliente com este e-mail.' });
    }

    // Colunas confirmadas: nome_completo, email, senha, telefone, data_nascimento, empresa_id, ativo, tipo
    const { data: novoCliente, error } = await supabase
      .from('usuarios')
      .insert({
        nome_completo: nome.trim(),
        email: emailLimpo,
        senha: senhaHash,
        telefone: telLimpo,
        data_nascimento: valNasc,
        empresa_id,
        ativo: true,
        tipo: 'cliente'
      })
      .select('id')
      .single();

    if (error) throw error;

    console.log(`Cliente criado: ID ${novoCliente.id} | ${nome} | empresa ${empresa_id}`);
    res.json({ id: novoCliente.id, nome: nome.trim() });
  } catch (err) {
    console.error('Erro em clientes/rapido:', err.code, err.message);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Já existe um cliente com este e-mail ou telefone.' });
    }
    res.status(500).json({ error: err.message || 'Erro interno ao cadastrar cliente.' });
  }
});

module.exports = router;
