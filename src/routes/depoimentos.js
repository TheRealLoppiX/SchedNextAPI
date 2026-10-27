const express = require('express');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const validate = require('../middleware/validate');
const { depoimentosSchema, depoimentoEmpresaSchema } = require('../schemas');

// Depoimentos exibidos na landing ("Quem usa, recomenda"). Vêm das próprias empresas que usam a
// SchedNext (cartão "Avalie a SchedNext" no painel, AdminConta.js) e, opcionalmente, de cadastro
// manual no admin absoluto. Ficam como JSON em plataforma_configuracoes ('depoimentos_landing'),
// sem tabela própria: são poucos.
//
// Moderação: o que a empresa envia (ou edita) entra como status 'pendente' e só aparece na
// landing depois que o admin absoluto aprova — a vitrine da plataforma não publica nada sozinha.
// status: 'pendente' | 'aprovado' | 'recusado'. Itens antigos sem status contam como aprovados.
const router = express.Router();
const CHAVE = 'depoimentos_landing';

async function lerDepoimentos() {
  const { data, error } = await supabase.from('plataforma_configuracoes').select('valor').eq('chave', CHAVE).maybeSingle();
  if (error) throw error;
  try {
    const lista = JSON.parse(data?.valor || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

async function gravarDepoimentos(lista) {
  const { error } = await supabase
    .from('plataforma_configuracoes')
    .upsert({ chave: CHAVE, valor: JSON.stringify(lista), atualizado_em: new Date().toISOString() }, { onConflict: 'chave' });
  if (error) throw error;
}

const publicado = (d) => d.ativo !== false && (d.status || 'aprovado') === 'aprovado';

// Público (landing): só os aprovados e publicados, sem campos internos.
router.get('/depoimentos', async (req, res) => {
  try {
    const lista = await lerDepoimentos();
    res.set('Cache-Control', 'public, max-age=300');
    res.json(lista.filter(publicado).map(({ id, nome, negocio, cidade, texto, nota, foto_url }) => ({ id, nome, negocio, cidade, texto, nota, foto_url })));
  } catch (err) {
    console.error('Erro ao listar depoimentos:', err);
    res.json([]);
  }
});

// --- Painel da empresa: uma avaliação por empresa, editável (cada edição volta pra moderação).

router.get('/admin/depoimento', async (req, res) => {
  try {
    const lista = await lerDepoimentos();
    const meu = lista.find((d) => String(d.empresa_id) === String(req.empresaId));
    res.json(meu ? { nome: meu.nome, cidade: meu.cidade, texto: meu.texto, nota: meu.nota, status: meu.status || 'aprovado' } : null);
  } catch (err) {
    console.error('Erro ao buscar depoimento da empresa:', err);
    res.status(500).json({ error: 'Erro ao carregar sua avaliação.' });
  }
});

router.put('/admin/depoimento', validate(depoimentoEmpresaSchema), async (req, res) => {
  try {
    const { data: empresa } = await supabase.from('empresas').select('nome').eq('id', req.empresaId).maybeSingle();
    const lista = await lerDepoimentos();
    const indice = lista.findIndex((d) => String(d.empresa_id) === String(req.empresaId));
    const dados = {
      nome: req.body.nome,
      negocio: empresa?.nome || '',
      cidade: req.body.cidade || '',
      texto: req.body.texto,
      nota: req.body.nota,
      foto_url: '',
      empresa_id: req.empresaId,
      status: 'pendente',
      ativo: true,
      enviado_em: new Date().toISOString()
    };
    if (indice >= 0) lista[indice] = { ...lista[indice], ...dados };
    else lista.push({ id: crypto.randomUUID(), ...dados });
    await gravarDepoimentos(lista);
    res.json({ message: 'Obrigado! Sua avaliação foi enviada e aparece no site depois de revisada.', status: 'pendente' });
  } catch (err) {
    console.error('Erro ao salvar depoimento da empresa:', err);
    res.status(500).json({ error: 'Erro ao enviar sua avaliação.' });
  }
});

// --- Admin absoluto: lista completa (inclusive pendentes) e substituição em bloco.

router.get('/super-admin/depoimentos', async (req, res) => {
  try {
    res.json(await lerDepoimentos());
  } catch (err) {
    console.error('Erro ao listar depoimentos (admin):', err);
    res.status(500).json({ error: 'Erro ao carregar os depoimentos.' });
  }
});

router.put('/super-admin/depoimentos', validate(depoimentosSchema), async (req, res) => {
  const lista = req.body.depoimentos.map((d) => ({ ...d, id: d.id || crypto.randomUUID() }));
  try {
    await gravarDepoimentos(lista);
    res.json({ message: 'Depoimentos salvos.', depoimentos: lista });
  } catch (err) {
    console.error('Erro ao salvar depoimentos:', err);
    res.status(500).json({ error: 'Erro ao salvar os depoimentos.' });
  }
});

module.exports = router;
