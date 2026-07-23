// América/São_Paulo é sempre UTC-3 (sem horário de verão desde 2019). O banco guarda data_hora
// como "horário de parede pretendido, rotulado como UTC": um agendamento às 09:00
// (horário local) é gravado como "09:00:00+00", sem conversão real de fuso (mesma convenção do
// MySQL original, que usava DATETIME ingênuo). Isso significa que comparar esse valor direto
// contra um Date() de verdade (que representa o instante real) fica errado por 3h. É preciso
// converter explicitamente nos dois sentidos.
const OFFSET_BRASILIA_MS = 3 * 60 * 60 * 1000;

// Converte o instante real (ex: "agora") para a mesma convenção "ingênua" usada no banco,
// para poder comparar direto nas queries.
function paraConvencaoDoBanco(instanteReal) {
  return new Date(instanteReal.getTime() - OFFSET_BRASILIA_MS);
}

// Converte um data_hora do banco (convenção ingênua) para o instante real correspondente.
function paraInstanteReal(dataHoraDoBanco) {
  return new Date(new Date(dataHoraDoBanco).getTime() + OFFSET_BRASILIA_MS);
}

module.exports = { paraConvencaoDoBanco, paraInstanteReal };
