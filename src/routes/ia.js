const express = require('express');
const { gerarTexto } = require('../services/groq');
const { permiteIA } = require('../utils/limitesPlano');

const router = express.Router();

const MENSAGEM_UPSELL = 'Recursos de IA são exclusivos dos planos Profissional e Enterprise.';

async function gated(req, res, next) {
  if (!(await permiteIA(req.empresaId))) {
    return res.status(403).json({ error: MENSAGEM_UPSELL });
  }
  next();
}

router.use('/admin/ia', gated);

// 1. Resumo executivo do dashboard — traduz os números em texto corrido com destaques,
// pra quem não quer ficar lendo tabela de estatística.
router.post('/admin/ia/resumo-dashboard', async (req, res) => {
  const { stats, nomeEmpresa } = req.body;
  if (!stats) return res.status(400).json({ error: 'Envie os dados de "stats".' });

  try {
    const texto = await gerarTexto({
      sistema: 'Você é um analista de negócios. Escreva um resumo executivo curto (3-4 frases), direto, em português do Brasil, destacando o que está bom e o que merece atenção. Sem saudação, sem markdown, só o texto corrido.',
      prompt: `Negócio: ${nomeEmpresa || 'Estabelecimento'}\nEstatísticas do período:\n${JSON.stringify(stats)}`,
      maxTokens: 220
    });
    res.json({ resumo: texto });
  } catch (e) {
    console.error('Erro no resumo de IA:', e);
    res.status(502).json({ error: 'Não foi possível gerar o resumo agora. Tente novamente em instantes.' });
  }
});

// 2. Gerador de descrição de serviço — admin digita só o nome, IA sugere uma descrição
// de vitrine pra usar no cadastro do serviço.
router.post('/admin/ia/descricao-servico', async (req, res) => {
  const { nome, vertical } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Informe o nome do serviço.' });

  try {
    const texto = await gerarTexto({
      sistema: 'Você escreve descrições curtas (1-2 frases) e atrativas de serviços para o cardápio de um negócio de hora marcada, em português do Brasil. Sem markdown, sem aspas, só o texto da descrição.',
      prompt: `Tipo de negócio: ${vertical || 'estabelecimento de hora marcada'}\nServiço: ${nome}`,
      maxTokens: 100
    });
    res.json({ descricao: texto });
  } catch (e) {
    console.error('Erro na descrição de IA:', e);
    res.status(502).json({ error: 'Não foi possível gerar a descrição agora. Tente novamente em instantes.' });
  }
});

// 3. Sugestão de mensagem de follow-up — personaliza o texto de "sentimos sua falta"
// enviado pro cliente que sumiu, em vez de um template fixo igual pra todo mundo.
router.post('/admin/ia/sugestao-followup', async (req, res) => {
  const { clienteNome, nomeEmpresa, diasSemVir } = req.body;
  if (!clienteNome) return res.status(400).json({ error: 'Informe o nome do cliente.' });

  try {
    const texto = await gerarTexto({
      sistema: 'Você escreve mensagens curtas e calorosas (2-3 frases) de "sentimos sua falta" para clientes que não voltam há um tempo, em português do Brasil, tom amigável e não insistente. Sem markdown, sem assinatura.',
      prompt: `Cliente: ${clienteNome}\nEstabelecimento: ${nomeEmpresa || 'nosso estabelecimento'}\nTempo sem aparecer: ${diasSemVir ? `${diasSemVir} dias` : 'um bom tempo'}`,
      maxTokens: 150
    });
    res.json({ mensagem: texto });
  } catch (e) {
    console.error('Erro na sugestão de follow-up de IA:', e);
    res.status(502).json({ error: 'Não foi possível gerar a sugestão agora. Tente novamente em instantes.' });
  }
});

module.exports = router;
