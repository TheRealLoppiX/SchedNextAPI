const express = require('express');
const dns = require('dns');
const supabase = require('../config/supabase');
const { permiteDominioCustomizado } = require('../utils/limitesPlano');
const validate = require('../middleware/validate');
const { dominioCustomizadoSchema } = require('../schemas');

const router = express.Router();

// Domínio próprio é um recurso exclusivo do plano Enterprise (ver §3 do plano de plataforma).
// A empresa aponta um domínio (ou subdomínio) dela via CNAME pro nosso domínio raiz; a
// verificação compara os IPs resolvidos dos dois, o que cobre tanto CNAME literal quanto
// "CNAME flattening" (comum em provedores como Cloudflare, que a própria plataforma usa) sem
// depender de hardcodar os IPs do Render, que podem mudar.
const DOMINIO_RAIZ = process.env.DOMINIO_RAIZ_PLATAFORMA || 'schednext.com.br';

async function dominioApontaParaPlataforma(dominio) {
  try {
    const [ipsAlvo, ipsDominio] = await Promise.all([
      dns.promises.resolve4(DOMINIO_RAIZ),
      dns.promises.resolve4(dominio)
    ]);
    return ipsDominio.some((ip) => ipsAlvo.includes(ip));
  } catch (err) {
    return false;
  }
}

// Rota pública: o frontend (SPA estático) chama isso quando é acessado por um hostname que
// não é o domínio raiz nem um subdomínio *.schednext.com.br, pra descobrir de qual tenant é
// esse domínio próprio (ver utils/tenantSubdominio.js no frontend).
router.get('/dominio/resolver', async (req, res) => {
  const host = String(req.query.host || '').trim().toLowerCase();
  if (!host) return res.status(400).json({ error: 'Host não informado.' });

  const { data, error } = await supabase
    .from('empresas')
    .select('slug')
    .eq('dominio_customizado', host)
    .eq('dominio_verificado', true)
    .maybeSingle();

  if (error || !data) return res.status(404).json({ error: 'Domínio não encontrado.' });
  res.json({ slug: data.slug });
});

router.get('/admin/dominio/:empresaId', async (req, res) => {
  const { data, error } = await supabase
    .from('empresas')
    .select('dominio_customizado, dominio_verificado')
    .eq('id', req.empresaId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar domínio.' });
  res.json({
    dominio_customizado: data?.dominio_customizado || null,
    dominio_verificado: !!data?.dominio_verificado,
    dominio_alvo: DOMINIO_RAIZ
  });
});

router.post('/admin/dominio', validate(dominioCustomizadoSchema), async (req, res) => {
  const { dominio } = req.body;
  const empresa_id = req.empresaId;

  if (!(await permiteDominioCustomizado(empresa_id))) {
    return res.status(403).json({ error: 'Domínio próprio é um recurso exclusivo do plano Enterprise. Fale com o suporte para fazer upgrade.' });
  }

  if (dominio === DOMINIO_RAIZ || dominio.endsWith(`.${DOMINIO_RAIZ}`)) {
    return res.status(400).json({ error: `Esse domínio já pertence à plataforma. Use um domínio próprio, ex: agenda.suaempresa.com.br.` });
  }

  const { data: emUso } = await supabase
    .from('empresas')
    .select('id')
    .eq('dominio_customizado', dominio)
    .neq('id', empresa_id)
    .maybeSingle();
  if (emUso) return res.status(409).json({ error: 'Esse domínio já está em uso por outra empresa.' });

  const { error } = await supabase
    .from('empresas')
    .update({ dominio_customizado: dominio, dominio_verificado: false })
    .eq('id', empresa_id);

  if (error) return res.status(500).json({ error: 'Erro ao salvar o domínio.' });
  res.json({ success: true, dominio_customizado: dominio, dominio_verificado: false, dominio_alvo: DOMINIO_RAIZ });
});

router.post('/admin/dominio/verificar', async (req, res) => {
  const empresa_id = req.empresaId;

  if (!(await permiteDominioCustomizado(empresa_id))) {
    return res.status(403).json({ error: 'Domínio próprio é um recurso exclusivo do plano Enterprise.' });
  }

  const { data: empresa, error } = await supabase
    .from('empresas')
    .select('dominio_customizado')
    .eq('id', empresa_id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erro ao buscar domínio.' });
  if (!empresa?.dominio_customizado) return res.status(400).json({ error: 'Cadastre um domínio antes de verificar.' });

  const aponta = await dominioApontaParaPlataforma(empresa.dominio_customizado);

  if (aponta) {
    await supabase.from('empresas').update({ dominio_verificado: true }).eq('id', empresa_id);
  }

  res.json({
    dominio_customizado: empresa.dominio_customizado,
    dominio_verificado: aponta,
    mensagem: aponta
      ? 'Domínio verificado! Ele já está ativo na plataforma.'
      : `Ainda não encontramos o apontamento correto. Confira se o CNAME de "${empresa.dominio_customizado}" aponta para ${DOMINIO_RAIZ} e aguarde a propagação do DNS (pode levar algumas horas).`
  });
});

router.delete('/admin/dominio', async (req, res) => {
  const { error } = await supabase
    .from('empresas')
    .update({ dominio_customizado: null, dominio_verificado: false })
    .eq('id', req.empresaId);

  if (error) return res.status(500).json({ error: 'Erro ao remover o domínio.' });
  res.json({ success: true });
});

module.exports = router;
