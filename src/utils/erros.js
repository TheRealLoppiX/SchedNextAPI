// Resposta de erro interno sem vazar detalhes. Antes várias rotas faziam res.status(500).json(error)
// com o erro cru do Supabase/Postgres, que traz nome de tabela, coluna, constraint e dica do
// banco — informação útil pra quem está mapeando a aplicação pra atacar. O detalhe vai só pro log.
function respostaErroInterno(res, erro, contexto = 'Erro interno') {
  console.error(`${contexto}:`, erro);
  return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
}

// Último middleware do app (ver server.js). No Express 5 uma exceção não tratada numa rota
// async cai aqui; sem isso, o handler padrão do Express devolve o stack trace em HTML quando
// NODE_ENV não é 'production'. Erros do body-parser (JSON malformado, corpo grande demais)
// mantêm o status próprio (4xx), com mensagem genérica.
// eslint-disable-next-line no-unused-vars
function tratadorDeErros(err, req, res, next) {
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: status === 413 ? 'Requisição grande demais.' : 'Requisição inválida.' });
  }
  console.error(`Erro não tratado em ${req.method} ${req.originalUrl.split('?')[0]}:`, err);
  if (res.headersSent) return undefined;
  return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
}

module.exports = { respostaErroInterno, tratadorDeErros };
