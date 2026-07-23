const { z } = require('zod');

// Peças reutilizáveis. `idLike` cobre valores de ID que podem chegar como number (enviados
// direto de state numérico) ou string (vindos de params/inputs). Sempre repassados pro
// Supabase como estão, nunca usados em aritmética, então não precisam de coerção.
const idLike = z.union([z.string(), z.number()]);
const idLikeNullable = idLike.optional().nullable();
const textoOpcionalNullable = z.string().trim().optional().nullable();
// Reaproveitado por toda rota "liga/desliga" genérica (produto, serviço, plano de assinatura
// da barbearia etc.) que só recebe { ativo: boolean }.
const ativoSchema = z.object({ ativo: z.boolean() });

const registrarSchema = z.object({
  nome: z.string().trim().min(2, 'Nome muito curto').max(150),
  nascimento: z.string().optional().nullable(),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  telefone: z.string().trim().min(8, 'Telefone inválido').max(20),
  senha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100),
  empresaSlug: z.string().trim().min(1)
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(1, 'Senha é obrigatória')
});

const agendarSchema = z.object({
  usuario_id: idLike,
  barbeiro_id: idLike,
  empresa_slug: z.string().trim().min(1),
  data_hora: z.string().min(1),
  servicos: z.array(z.object({ id: idLike })).min(1, 'Selecione ao menos um serviço'),
  unidade_id: idLikeNullable
});

const clienteRapidoSchema = z.object({
  nome: z.string().trim().min(2, 'Nome é obrigatório'),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(3, 'Senha é obrigatória'),
  tel: z.string().trim().min(8, 'Telefone é obrigatório'),
  nasc: z.string().optional().nullable(),
  empresa_id: idLike
});

const registrarEmpresaSchema = z.object({
  nome: z.string().trim().min(2, 'Nome muito curto').max(150),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, 'Use apenas letras minúsculas, números e hífen').min(3).max(60),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100),
  vertical: z.enum(['barbearia', 'salao', 'estudio_unhas', 'generico']),
  plano_plataforma_id: idLike.optional()
});

// --- auth.js (fluxos de código de 6 dígitos) ---

const confirmarCodigoSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  codigo: z.string().trim().length(6, 'Código deve ter 6 dígitos')
});

const recuperarSenhaSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido')
});

const resetarSenhaSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  codigo: z.string().trim().length(6, 'Código deve ter 6 dígitos'),
  novaSenha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100)
});

const segurancaCodigoSchema = z.object({
  id: idLike
});

const segurancaUpdateSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100),
  codigo: z.string().trim().length(6, 'Código deve ter 6 dígitos')
});

const segurancaValidarSchema = z.object({
  id: idLike,
  codigo: z.string().trim().length(6, 'Código deve ter 6 dígitos')
});

// --- perfil.js ---

const perfilAtualizarSchema = z.object({
  nome_completo: z.string().trim().min(1).max(150).optional().nullable(),
  telefone: z.string().trim().max(20).optional().nullable(),
  nascimento: z.string().optional().nullable(),
  foto_url: z.string().trim().optional().nullable()
});

const avaliarSchema = z.object({
  agendamento_id: idLike,
  barbeiro_id: idLikeNullable,
  nota: z.coerce.number().int().min(1, 'Nota mínima é 1').max(5, 'Nota máxima é 5'),
  comentario: textoOpcionalNullable
});

// --- empresa.js ---

const empresaAtualizarSchema = z.object({
  nome: z.string().trim().min(1).max(150).optional(),
  logo_url: z.string().trim().optional().nullable(),
  horarios: z.record(z.string(), z.any()).optional().nullable(),
  cor_principal: z.string().trim().max(20).optional(),
  cor_destaque: z.string().trim().max(20).optional()
});

const configEmpresaSchema = z.object({
  nome_fantasia: z.string().trim().min(1).max(150).optional(),
  logo_url: z.string().trim().optional().nullable(),
  cor_primary: z.string().trim().max(20).optional()
});

// --- estoque.js ---

const estoqueProdutoSchema = z.object({
  nome: z.string().trim().min(1, 'Nome do produto é obrigatório').max(150),
  valor: z.coerce.number().min(0, 'Valor não pode ser negativo'),
  quantidade: z.coerce.number().int('Quantidade deve ser um número inteiro')
});

const estoqueLoginSchema = z.object({
  usuario: z.string().trim().min(1, 'Selecione um operador'),
  senha: z.string().min(1, 'Senha é obrigatória')
});

const estoqueCriarSubloginSchema = z.object({
  senha_admin: z.string().min(1, 'Senha administrativa é obrigatória'),
  novo_nome: z.string().trim().min(1, 'Nome do colaborador é obrigatório').max(150),
  nova_senha: z.string().min(3, 'Senha deve ter ao menos 3 caracteres').max(100)
});

const estoqueMovimentarSchema = z.object({
  produto_id: idLike,
  usuario_nome: z.string().trim().min(1),
  quantidade: z.coerce.number().int().positive('Quantidade deve ser maior que zero'),
  tipo: z.enum(['ADICIONAR', 'REMOVER']),
  justificativa: textoOpcionalNullable
});

// --- servicos.js (rotas de gestão) ---

const servicoGestaoSchema = z.object({
  nome: z.string().trim().min(1, 'Nome do serviço é obrigatório').max(150),
  valor: z.coerce.number().min(0, 'Valor não pode ser negativo'),
  duracao: z.coerce.number().int().min(5, 'Duração mínima é 5 minutos').max(480, 'Duração máxima é 8 horas'),
  descricao: textoOpcionalNullable
});

// --- barbeiros.js ---

const barbeiroCriarSchema = z.object({
  nome: z.string().trim().min(1, 'Nome é obrigatório').max(150),
  foto_url: z.string().trim().optional().nullable(),
  unidade_id: idLikeNullable
});

const barbeiroEditarSchema = z.object({
  id: idLike,
  nome: z.string().trim().min(1, 'Nome é obrigatório').max(150),
  foto_url: z.string().trim().optional().nullable()
});

const barbeiroStatusSchema = z.object({
  id: idLike,
  ativo: z.boolean()
});

const bloqueioSchema = z.object({
  barbeiro_id: idLike,
  data_bloqueio: z.string().min(1),
  data_fim: z.string().optional().nullable(),
  hora_inicio: z.string().min(1),
  hora_fim: z.string().min(1),
  motivo: textoOpcionalNullable
});

const barbeiroServicosSchema = z.object({
  barbeiro_id: idLike,
  servicosIds: z.array(idLike)
});

// --- unidades.js ---

const unidadeCriarSchema = z.object({
  nome: z.string().trim().min(1, 'Nome da unidade é obrigatório').max(150),
  endereco: textoOpcionalNullable
});

const unidadeAtualizarSchema = z.object({
  nome: z.string().trim().min(1).max(150).optional(),
  endereco: textoOpcionalNullable,
  horarios_funcionamento: z.record(z.string(), z.any()).optional().nullable(),
  ativo: z.boolean().optional()
});

// --- clientes.js ---

const clienteAtualizarSchema = z.object({
  nome_completo: z.string().trim().min(1).max(150).optional(),
  telefone: z.string().trim().max(20).optional().nullable(),
  email: z.string().trim().toLowerCase().email('E-mail inválido').optional(),
  data_nascimento: z.string().optional().nullable(),
  notas: textoOpcionalNullable
});

const clienteAssinanteSchema = z.object({
  assinante: z.boolean()
});

const clienteFollowupSchema = z.object({
  cliente_id: idLike,
  tipo: z.enum(['saudade', 'aniversario'])
});

// --- agendamentos.js (rotas administrativas) ---

const encaixeSchema = z.object({
  barbeiro_id: idLike,
  cliente_nome: z.string().trim().min(1, 'Nome do cliente é obrigatório'),
  data_hora: z.string().min(1),
  servicos_ids: z.array(idLike).min(1, 'Selecione ao menos um serviço')
});

const finalizarEncaixeCompletoSchema = z.object({
  barbeiro_id: idLike,
  data_hora: z.string().min(1),
  servicos_ids: z.array(idLike).optional(),
  isNovoCliente: z.boolean(),
  clienteData: z.object({
    id: idLike.optional(),
    nome_completo: z.string().trim().optional().nullable(),
    email: z.string().trim().toLowerCase().email('E-mail inválido').optional().nullable(),
    senha: z.string().optional().nullable(),
    telefone: z.string().trim().optional().nullable(),
    data_nascimento: z.string().optional().nullable()
  })
});

const confirmarAgendamentoSchema = z.object({
  agendamento_id: idLike
});

const cancelarAgendamentoSchema = z.object({
  agendamento_id: idLike,
  justificativa: textoOpcionalNullable,
  enviadoPor: textoOpcionalNullable
});

const finalizarCheckoutSchema = z.object({
  agendamento_id: idLike,
  produtos_vendidos: z.array(z.object({ id: idLike, quantidade: z.coerce.number().int().positive().optional() })).optional(),
  servicos_adicionais: z.array(z.object({ id: idLike })).optional()
});

const agendarEncaixeSchema = z.object({
  barbeiro_id: idLike,
  usuario_id: idLikeNullable,
  data_hora: z.string().min(1),
  servicos: z.array(z.object({ id: idLike }).passthrough()).optional(),
  cliente_nome: textoOpcionalNullable
});

// --- fidelidade.js ---

const acaoFidelidadeSchema = z.object({
  nome: z.string().trim().min(1, 'Nome da ação é obrigatório').max(150),
  data_inicio: z.string().min(1),
  data_fim: z.string().min(1),
  cortes_necessarios: z.coerce.number().int().positive('Deve ser maior que zero'),
  valor_minimo: z.coerce.number().min(0),
  premio_descritivo: z.string().trim().min(1, 'Descreva o prêmio'),
  tipo_premio: z.enum(['servico', 'produto', 'desconto']).optional()
});

const acaoStatusSchema = z.object({
  ativar: z.boolean()
});

// --- assinaturas.js ---

const assinaturaPlanoSchema = z.object({
  nome: z.string().trim().min(1, 'Nome do plano é obrigatório').max(150),
  preco: z.coerce.number().min(0),
  descricao: textoOpcionalNullable,
  servicos_ids: z.array(idLike).optional()
});

const clientePlanoSchema = z.object({
  plano_id: idLikeNullable
});

// --- pagamentos.js ---

const iniciarUpgradeSchema = z.object({
  plano_plataforma_id: idLike,
  // Só obrigatório quando o plano escolhido é pago e a empresa ainda não tem CPF/CNPJ salvo
  // (checado na própria rota, não aqui, porque depende do estado atual da empresa no banco).
  cpf_cnpj: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/\D/g, '') : v),
    z.string().regex(/^\d{11}$|^\d{14}$/, 'Informe um CPF ou CNPJ válido.')
  ).optional()
});

// --- apiKeys.js ---

const apiKeyCriarSchema = z.object({
  nome: z.string().trim().min(1, 'Dê um nome pra essa chave').max(150)
});

// --- empresa.js / empresasPublico.js (contato Enterprise) ---

const contatoEnterpriseSchema = z.object({
  nome_empresa: z.string().trim().min(2, 'Nome muito curto').max(150),
  cnpj: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/\D/g, '') : v),
    z.string().regex(/^\d{14}$/, 'Informe um CNPJ válido.')
  ),
  localizacao: z.string().trim().min(2, 'Informe a localização').max(150),
  clientes_esperados: z.string().trim().min(1, 'Informe uma estimativa').max(100),
  observacoes: textoOpcionalNullable,
  email_contato: z.string().trim().toLowerCase().email('E-mail inválido'),
  telefone_contato: z.string().trim().max(20).optional().nullable()
});

// --- superAdmin.js ---

const superAdminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(1, 'Senha é obrigatória')
});

const leadStatusSchema = z.object({
  status: z.enum(['novo', 'contatado', 'fechado'])
});

module.exports = {
  registrarSchema,
  loginSchema,
  agendarSchema,
  clienteRapidoSchema,
  registrarEmpresaSchema,
  confirmarCodigoSchema,
  recuperarSenhaSchema,
  resetarSenhaSchema,
  segurancaCodigoSchema,
  segurancaUpdateSchema,
  segurancaValidarSchema,
  perfilAtualizarSchema,
  avaliarSchema,
  empresaAtualizarSchema,
  configEmpresaSchema,
  ativoSchema,
  estoqueProdutoSchema,
  estoqueLoginSchema,
  estoqueCriarSubloginSchema,
  estoqueMovimentarSchema,
  servicoGestaoSchema,
  barbeiroCriarSchema,
  barbeiroEditarSchema,
  barbeiroStatusSchema,
  bloqueioSchema,
  barbeiroServicosSchema,
  unidadeCriarSchema,
  unidadeAtualizarSchema,
  clienteAtualizarSchema,
  clienteAssinanteSchema,
  clienteFollowupSchema,
  encaixeSchema,
  finalizarEncaixeCompletoSchema,
  confirmarAgendamentoSchema,
  cancelarAgendamentoSchema,
  finalizarCheckoutSchema,
  agendarEncaixeSchema,
  acaoFidelidadeSchema,
  acaoStatusSchema,
  assinaturaPlanoSchema,
  clientePlanoSchema,
  iniciarUpgradeSchema,
  apiKeyCriarSchema,
  contatoEnterpriseSchema,
  superAdminLoginSchema,
  leadStatusSchema
};
