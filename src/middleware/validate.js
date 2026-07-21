// Validação de body com zod nas rotas mais sensíveis (ver handoff.md, Fase 2 do plano de ação).
function validate(schema) {
  return (req, res, next) => {
    const resultado = schema.safeParse(req.body);
    if (!resultado.success) {
      return res.status(400).json({
        error: 'Dados inválidos',
        detalhes: resultado.error.issues.map(i => ({ campo: i.path.join('.'), mensagem: i.message }))
      });
    }
    req.body = resultado.data;
    next();
  };
}

module.exports = validate;
