const express = require('express');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const {
  prospeccaoConfigSchema,
  prospeccaoImportarSchema,
  prospectAtualizarSchema,
  prospeccaoTesteSchema,
  whatsappTesteSchema
} = require('../schemas');
const {
  estaConfigurado,
  enviarMensagem,
  criarInstancia,
  obterQrCode,
  obterCodigoPareamento,
  obterStatusConexao,
  aplicarConfiguracoes,
  removerInstancia
} = require('../services/whatsapp/provider');
const prospeccao = require('../services/prospeccao');

// Prospecção de clientes por WhatsApp (ver services/prospeccao.js). Tudo sob /super-admin, então
// verificarTokenSuperAdmin (server.js) já garantiu que é o dono da plataforma.
const router = express.Router();

// O chip de prospecção costuma ser um celular com conversas antigas: baixar todo o histórico e
// receber mensagens de grupo só pesa na VPS da Evolution (1 GB de RAM, compartilhada com o
// WhatsApp de todas as empresas) e não serve pra nada aqui.
const CONFIG_INSTANCIA = { syncFullHistory: false, groupsIgnore: true, readMessages: false, alwaysOnline: false };

// Instâncias conectadas antes desse ajuste existir recebem a config uma vez por processo.
let configAplicada = null;
async function garantirConfigInstancia(instancia) {
  if (configAplicada === instancia) return;
  try {
    await aplicarConfiguracoes(instancia, CONFIG_INSTANCIA);
    configAplicada = instancia;
  } catch (err) {
    console.error('Prospecção: erro ao aplicar config da instância:', err.message || err);
  }
}

const STATUS = ['na_fila', 'abertura_enviada', 'followup_enviado', 'respondeu', 'sem_resposta', 'optout', 'pausado', 'erro'];

// Painel: config, conexão do WhatsApp, contagem por status e por que está (ou não) enviando.
router.get('/super-admin/prospeccao/resumo', async (req, res) => {
  try {
    const config = await prospeccao.carregarConfig();
    const instancia = await prospeccao.obterInstanciaProspeccao({ semCache: true });

    let conectado = false;
    if (instancia && estaConfigurado()) {
      const status = await obterStatusConexao(instancia).catch(() => ({ state: 'close' }));
      conectado = status.state === 'open';
      if (conectado) garantirConfigInstancia(instancia);
    }

    const contagens = {};
    await Promise.all(STATUS.map(async (status) => {
      const { count } = await supabase.from('prospects').select('id', { count: 'exact', head: true }).eq('status', status);
      contagens[status] = count || 0;
    }));

    const situacao = await prospeccao.situacao(config);
    const proximoEnvioEm = await prospeccao.lerChave(prospeccao.CHAVE_PROXIMO_ENVIO);

    res.json({
      config,
      whatsapp: { disponivel: estaConfigurado(), instancia, conectado },
      contagens,
      enviadasHoje: await prospeccao.contarEnviadasHoje(),
      situacao: {
        enviando: situacao.podeEnviar && conectado,
        motivo: situacao.podeEnviar && !conectado ? 'WhatsApp de prospecção desconectado.' : situacao.motivo || null,
        proximoEnvioEm
      }
    });
  } catch (err) {
    console.error('Erro ao montar resumo da prospecção:', err);
    res.status(500).json({ error: 'Erro ao carregar a prospecção. Confira se o SQL 2026_prospeccao_whatsapp.sql já foi rodado no Supabase.' });
  }
});

router.put('/super-admin/prospeccao/config', validate(prospeccaoConfigSchema), async (req, res) => {
  try {
    const config = await prospeccao.salvarConfig(req.body);
    // Religar os disparos não deve esperar o intervalo de uma sessão antiga.
    if (req.body.ativo === true) await prospeccao.gravarChave(prospeccao.CHAVE_PROXIMO_ENVIO, null);
    res.json({ message: 'Configuração salva.', config });
  } catch (err) {
    console.error('Erro ao salvar config da prospecção:', err);
    res.status(500).json({ error: 'Erro ao salvar a configuração.' });
  }
});

// Lista paginada com filtro por status e busca por nome/cidade/telefone.
router.get('/super-admin/prospeccao/prospects', async (req, res) => {
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const porPagina = 50;
  let query = supabase
    .from('prospects')
    .select('*', { count: 'exact' })
    .order('prioridade_ordem', { ascending: true })
    .order('id', { ascending: true })
    .range((pagina - 1) * porPagina, pagina * porPagina - 1);

  if (STATUS.includes(req.query.status)) query = query.eq('status', req.query.status);
  const busca = String(req.query.busca || '').trim().replace(/[%,()]/g, '');
  if (busca) {
    const digitos = busca.replace(/\D/g, '');
    const filtros = [`empresa.ilike.%${busca}%`, `cidade.ilike.%${busca}%`];
    if (digitos.length >= 4) filtros.push(`telefone.ilike.%${digitos}%`);
    query = query.or(filtros.join(','));
  }

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'Erro ao buscar prospects.' });
  res.json({ prospects: data, total: count || 0, pagina, porPagina });
});

router.get('/super-admin/prospeccao/prospects/:id/envios', async (req, res) => {
  const { data, error } = await supabase
    .from('prospeccao_envios')
    .select('*')
    .eq('prospect_id', req.params.id)
    .order('enviado_em', { ascending: true });
  if (error) return res.status(500).json({ error: 'Erro ao buscar o histórico.' });
  res.json(data);
});

router.post('/super-admin/prospeccao/importar', validate(prospeccaoImportarSchema), async (req, res) => {
  try {
    const resultado = await prospeccao.importarProspects(req.body.linhas, req.body.origem);
    res.json(resultado);
  } catch (err) {
    console.error('Erro ao importar prospects:', err);
    res.status(500).json({ error: 'Erro ao importar a planilha.' });
  }
});

// Ações manuais: pausar, devolver pra fila, marcar como respondeu/sem resposta/saída, anotar.
router.put('/super-admin/prospeccao/prospects/:id', validate(prospectAtualizarSchema), async (req, res) => {
  const mudancas = {};
  if (req.body.status) {
    mudancas.status = req.body.status;
    // Voltar pra fila recomeça do zero (útil pra quem deu erro ou foi pausado antes da abertura).
    if (req.body.status === 'na_fila') Object.assign(mudancas, { erro: null, mensagens_enviadas: 0, ultimo_envio_em: null });
    if (req.body.status === 'respondeu') mudancas.respondeu_em = new Date().toISOString();
  }
  if (req.body.observacoes !== undefined) mudancas.observacoes = req.body.observacoes || null;
  if (!Object.keys(mudancas).length) return res.status(400).json({ error: 'Nada para atualizar.' });

  const { data, error } = await supabase.from('prospects').update(mudancas).eq('id', req.params.id).select().maybeSingle();
  if (error) return res.status(500).json({ error: 'Erro ao atualizar o prospect.' });
  if (!data) return res.status(404).json({ error: 'Prospect não encontrado.' });
  res.json(data);
});

router.delete('/super-admin/prospeccao/prospects/:id', async (req, res) => {
  const { error } = await supabase.from('prospects').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Erro ao excluir o prospect.' });
  res.json({ success: true });
});

// Manda uma mensagem de exemplo pro próprio admin, pra ver como chega no celular antes de ligar.
router.post('/super-admin/prospeccao/teste', validate(prospeccaoTesteSchema), async (req, res) => {
  const numero = prospeccao.normalizarCelular(req.body.telefone);
  if (!numero) return res.status(400).json({ error: 'Informe um celular com DDD.' });
  const instancia = await prospeccao.obterInstanciaProspeccao({ semCache: true });
  if (!instancia || !estaConfigurado()) return res.status(400).json({ error: 'Conecte o WhatsApp de prospecção primeiro.' });

  const config = await prospeccao.carregarConfig();
  const exemplo = { id: 0, empresa: 'Barbearia Exemplo', cidade: 'Curitiba', bairro: 'Centro', categoria: 'Barbearia' };
  const modelo = req.body.followup
    ? config.mensagem_followup
    : (config.mensagens_abertura || [])[req.body.variante || 0];
  if (!modelo) return res.status(400).json({ error: 'Essa mensagem está vazia.' });

  const envio = await enviarMensagem(instancia, numero, prospeccao.montarTexto(modelo, exemplo, config)).catch((err) => ({ enviado: false, erro: err }));
  if (!envio?.enviado) return res.status(502).json({ error: 'O WhatsApp não aceitou o envio. Confira se o número de prospecção está conectado.' });
  res.json({ message: 'Mensagem de teste enviada.' });
});

// --- Conexão do WhatsApp de prospecção: QR Code ou código de pareamento, igual ao admin da
// empresa (routes/whatsappInstancia.js), numa instância própria (NOME_INSTANCIA).

const conectada = async (instancia) => (await obterStatusConexao(instancia).catch(() => ({ state: 'close' }))).state === 'open';

// Apaga a instância na Evolution e cria de novo do zero: usado quando ela ficou presa (não está
// conectada e também não gera QR Code/código novo).
async function recriarInstancia(opcoes) {
  const instancia = prospeccao.NOME_INSTANCIA;
  await removerInstancia(instancia).catch((err) => console.error('Prospecção: erro ao remover instância presa:', err.message || err));
  // A Evolution leva um instante pra liberar o nome depois do delete.
  await new Promise((r) => setTimeout(r, 1500));
  const criada = await criarInstancia(instancia, { ...opcoes, configuracoes: CONFIG_INSTANCIA });
  await prospeccao.definirInstanciaProspeccao(instancia);
  return criada;
}

// Cria a instância de prospecção na Evolution. Se ela já existir lá (ex: um "Desconectar" anterior
// em que a Evolution não conseguiu apagá-la): conectada, só reaproveita; senão, recria do zero.
async function criarOuReaproveitarInstancia(opcoes) {
  const instancia = prospeccao.NOME_INSTANCIA;
  let criada = null;
  try {
    criada = await criarInstancia(instancia, { ...opcoes, configuracoes: CONFIG_INSTANCIA });
  } catch (err) {
    if (!/already in use/i.test(err.message || '')) throw err;
    if (await conectada(instancia)) await aplicarConfiguracoes(instancia, CONFIG_INSTANCIA).catch(() => {});
    else criada = await recriarInstancia(opcoes);
  }
  await prospeccao.definirInstanciaProspeccao(instancia);
  return { instancia, criada };
}

router.post('/super-admin/prospeccao/whatsapp/qrcode', async (req, res) => {
  if (!estaConfigurado()) return res.status(503).json({ error: 'Integração de WhatsApp não está disponível no momento.' });
  try {
    let instancia = await prospeccao.obterInstanciaProspeccao({ semCache: true });
    let qrcode;
    if (!instancia) {
      const resultado = await criarOuReaproveitarInstancia({});
      instancia = resultado.instancia;
      qrcode = resultado.criada?.qrcode;
    }
    if (!qrcode?.base64) qrcode = await obterQrCode(instancia);
    if (!qrcode?.base64 && !(await conectada(instancia))) qrcode = (await recriarInstancia({}))?.qrcode;
    if (!qrcode?.base64) return res.status(409).json({ error: 'Não foi possível gerar o QR Code agora. Se o WhatsApp já estiver conectado, não é preciso escanear de novo.' });
    res.json({ qrcode: qrcode.base64 });
  } catch (err) {
    console.error('Erro ao gerar QR Code da prospecção:', err);
    res.status(500).json({ error: err.message || 'Erro ao gerar o QR Code.' });
  }
});

router.post('/super-admin/prospeccao/whatsapp/codigo', validate(whatsappTesteSchema), async (req, res) => {
  if (!estaConfigurado()) return res.status(503).json({ error: 'Integração de WhatsApp não está disponível no momento.' });
  let numero = req.body.telefone.replace(/\D/g, '');
  if (numero.length === 10 || numero.length === 11) numero = `55${numero}`;
  if (numero.length < 12 || numero.length > 13) return res.status(400).json({ error: 'Informe o número do WhatsApp com DDD. Ex: (11) 91234-5678.' });

  try {
    let instancia = await prospeccao.obterInstanciaProspeccao({ semCache: true });
    if (!instancia) {
      // qrcode: false de propósito, senão o pedido de código volta vazio (ver criarInstancia).
      ({ instancia } = await criarOuReaproveitarInstancia({ qrcode: false }));
    }
    let dados = await obterCodigoPareamento(instancia, numero);
    if (!dados?.pairingCode && !(await conectada(instancia))) {
      await recriarInstancia({ qrcode: false });
      dados = await obterCodigoPareamento(instancia, numero);
    }
    if (!dados?.pairingCode) return res.status(409).json({ error: 'Não foi possível gerar o código agora. Se o WhatsApp já estiver conectado, não é preciso conectar de novo; senão, tente pelo QR Code.' });
    res.json({ codigo: dados.pairingCode });
  } catch (err) {
    console.error('Erro ao gerar código de pareamento da prospecção:', err);
    res.status(500).json({ error: err.message || 'Erro ao gerar o código de conexão.' });
  }
});

router.post('/super-admin/prospeccao/whatsapp/desconectar', async (req, res) => {
  const instancia = await prospeccao.obterInstanciaProspeccao({ semCache: true });
  if (instancia) {
    try {
      await removerInstancia(instancia);
    } catch (err) {
      // Não apaga o registro nosso se a Evolution não desligou: senão a tela mostrava "desconectado"
      // com o celular ainda conectado, e reconectar dava "already in use".
      console.error('Erro ao remover a instância de prospecção:', err);
      if (await conectada(instancia)) {
        return res.status(502).json({ error: 'O servidor do WhatsApp não conseguiu desconectar agora. Tente de novo em instantes, ou desconecte pelo celular (Aparelhos conectados).' });
      }
    }
  }
  await prospeccao.definirInstanciaProspeccao(null);
  res.json({ success: true, message: 'WhatsApp de prospecção desconectado.' });
});

module.exports = router;
