const { z } = require('zod');

// Peças reutilizáveis. `idLike` cobre valores de ID que podem chegar como number (enviados
// direto de state numérico) ou string (vindos de params/inputs). Sempre repassados pro
// Supabase como estão, nunca usados em aritmética, então não precisam de coerção.
const idLike = z.union([z.string(), z.number()]);
const idLikeNullable = idLike.optional().nullable();
const textoOpcionalNullable = z.string().trim().optional().nullable();
// Reaproveitado por toda rota "liga/desliga" genérica (produto, serviço, plano de assinatura
// da empresa etc.) que só recebe { ativo: boolean }.
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

// Login de cliente é escopado por empresa (o slug vem da URL/subdomínio do tenant) — sem isso,
// e-mail/senha válidos em qualquer empresa autenticavam em qualquer outra, inclusive slugs
// inexistentes (ver POST /login em routes/auth.js).
const loginClienteSchema = loginSchema.extend({
  empresaSlug: z.string().trim().min(1, 'Empresa não informada')
});

// --- POST /login-magico (ver services/loginMagico.js) ---

const loginMagicoSchema = z.object({
  token: z.string().trim().min(1, 'Token não informado')
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

// Reaproveitado pelo cadastro self-service e pela troca manual de vertical do admin absoluto
// (empresaTrocarVerticalSchema, ver superAdminPlataforma.js) — pra corrigir uma empresa
// cadastrada com o tipo de negócio errado sem precisar recriar a conta do zero.
const verticalEnum = z.enum(['barbearia', 'salao', 'estudio_unhas', 'generico']);

const registrarEmpresaSchema = z.object({
  nome: z.string().trim().min(2, 'Nome muito curto').max(150),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, 'Use apenas letras minúsculas, números e hífen').min(3).max(60),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100),
  vertical: verticalEnum,
  plano_plataforma_id: idLike.optional(),
  // Antifraude (ver services/antifraude.js): telefone e CPF/CNPJ são obrigatórios no cadastro
  // pra impedir várias contas grátis da mesma pessoa/negócio.
  telefone: z.string().trim().min(10, 'Telefone inválido').max(20),
  documento: z.string().trim().min(11, 'CPF/CNPJ inválido').max(18)
});

// --- auth.js (fluxos de código de 6 dígitos) ---

const confirmarCodigoSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  codigo: z.string().trim().length(6, 'Código deve ter 6 dígitos')
});

const recuperarSenhaSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  empresaSlug: z.string().trim().min(1, 'Empresa não informada')
});

const resetarSenhaSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  codigo: z.string().trim().length(6, 'Código deve ter 6 dígitos'),
  novaSenha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100)
});

// Recuperação de senha do login da barbearia (POST /auth/admin/login) — sem empresaSlug porque
// esse login não é escopado por tenant (busca direto por e-mail em `empresas`/`unidade_admins`,
// ver routes/auth.js). O reset reaproveita resetarSenhaSchema (mesmo formato).
const recuperarSenhaAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido')
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
  nova_senha: z.string().regex(/^\d{4}$/, 'PIN deve ter exatamente 4 dígitos numéricos')
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
  telefone: z.string().trim().max(20).optional().nullable(),
  unidade_id: idLikeNullable
});

const barbeiroEditarSchema = z.object({
  id: idLike,
  nome: z.string().trim().min(1, 'Nome é obrigatório').max(150),
  foto_url: z.string().trim().optional().nullable(),
  telefone: z.string().trim().max(20).optional().nullable(),
  percentual_comissao: z.coerce.number().min(0, 'Comissão não pode ser negativa').max(100, 'Comissão não pode passar de 100%').nullable().optional(),
  unidade_id: idLikeNullable
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

const unidadeAdminCriarSchema = z.object({
  nome: z.string().trim().min(1, 'Nome é obrigatório').max(150),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100)
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
  tipo: z.enum(['saudade', 'aniversario']),
  canal: z.enum(['email', 'whatsapp', 'ambos']).optional()
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

const formaPagamentoEnum = z.enum(['dinheiro', 'credito', 'debito', 'pix']);

const finalizarCheckoutSchema = z.object({
  agendamento_id: idLike,
  produtos_vendidos: z.array(z.object({ id: idLike, quantidade: z.coerce.number().int().positive().optional() })).optional(),
  servicos_adicionais: z.array(z.object({ id: idLike })).optional(),
  forma_pagamento: formaPagamentoEnum.optional().nullable(),
  // Pagamento dividido (ex: parte no crédito, parte no Pix) — quando presente, tem prioridade
  // sobre forma_pagamento (que fica ignorado). Cada perna soma pro valor total do atendimento;
  // validamos a soma exata no handler, onde já sabemos o valor final calculado no servidor.
  formas_pagamento: z.array(z.object({
    forma_pagamento: formaPagamentoEnum,
    valor: z.coerce.number().positive()
  })).min(1).max(4).optional()
});

const agendarEncaixeSchema = z.object({
  barbeiro_id: idLike,
  usuario_id: idLikeNullable,
  data_hora: z.string().min(1),
  servicos: z.array(z.object({ id: idLike }).passthrough()).optional(),
  cliente_nome: textoOpcionalNullable
});

const reagendarAgendamentoSchema = z.object({
  agendamento_id: idLike,
  barbeiro_id: idLike,
  data_hora: z.string().min(1)
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

// --- suporte.js ---

const suporteMensagemSchema = z.object({
  texto: z.string().trim().min(1, 'Digite uma mensagem').max(2000)
});

const suporteRepassarSchema = z.object({
  super_admin_id: z.string().uuid('Super admin inválido').nullable().optional()
});

// --- assinaturas.js ---

const assinaturaPlanoSchema = z.object({
  nome: z.string().trim().min(1, 'Nome do plano é obrigatório').max(150),
  preco: z.coerce.number().min(0),
  descricao: textoOpcionalNullable,
  servicos: z.array(z.object({
    id: idLike,
    limite_mensal: z.coerce.number().int().positive().optional().nullable()
  })).optional()
});

const clientePlanoSchema = z.object({
  plano_id: idLikeNullable
});

// --- pagamentos.js ---

const iniciarUpgradeSchema = z.object({
  plano_plataforma_id: idLike
});

// --- apiKeys.js ---

const apiKeyCriarSchema = z.object({
  nome: z.string().trim().min(1, 'Dê um nome pra essa chave').max(150)
});

// --- financeiro.js (taxas de maquineta) ---

const percentualTaxa = z.coerce.number().min(0, 'Taxa não pode ser negativa').max(100, 'Taxa não pode passar de 100%');

const taxasPagamentoSchema = z.object({
  taxas_pagamento: z.object({
    dinheiro: percentualTaxa.optional().default(0),
    credito: percentualTaxa.optional().default(0),
    debito: percentualTaxa.optional().default(0),
    pix: percentualTaxa.optional().default(0)
  })
});

// --- mercadopago.js ---

const mercadoPagoPixSchema = z.object({
  produtos_vendidos: z.array(z.object({ id: idLike, quantidade: z.coerce.number().int().positive().optional() })).optional(),
  servicos_adicionais: z.array(z.object({ id: idLike })).optional(),
  // Presente só em pagamento dividido: cobra esse valor específico via Pix em vez do total do
  // atendimento (o resto fica com outra(s) forma(s) registrada(s) no fechamento de caixa).
  valor: z.coerce.number().positive().optional()
});

const assinarAssinaturaSchema = z.object({
  // 'cartao' (padrão, mantém o fluxo de preapproval de sempre) ou 'pix' (gera uma cobrança Pix
  // avulsa pro ciclo atual — Mercado Pago não tem Pix recorrente, ver cron/cobrancaAssinaturas.js).
  forma_pagamento: z.enum(['cartao', 'pix']).optional()
});

// --- cobrancaAssinatura.js ---

const baixaManualAssinaturaSchema = z.object({
  // Mesmas formas de pagamento do checkout normal (formaPagamentoEnum) — permite aplicar a
  // mesma taxa de maquineta cadastrada (taxas_pagamento) e contar essa cobrança nos relatórios
  // de faturamento/receita líquida junto com o resto (ver routes/relatorios.js).
  forma_pagamento: formaPagamentoEnum,
  observacoes: textoOpcionalNullable
});

const vencimentoAssinaturaSchema = z.object({
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
});

// --- apiPublica.js ---

const apiPublicaAgendamentoSchema = z.object({
  profissional_id: idLike,
  data_hora: z.string().min(1),
  cliente_nome: z.string().trim().min(1, 'Informe o nome do cliente').max(150),
  servicos_ids: z.array(idLike).min(1, 'Selecione ao menos um serviço')
});

// --- whatsappInstancia.js ---

const whatsappTesteSchema = z.object({
  telefone: z.string().trim().min(8, 'Telefone inválido').max(20)
});

// boas_vindas e resumo_profissionais_* ficam liberados pra qualquer empresa com o bot ligado;
// modo/nome/personalidade/temperatura só têm efeito de fato quando o plano também libera IA
// (checado na rota, não aqui) — resumo diário não usa IA nenhuma, é texto fixo.
const whatsappBotConfigSchema = z.object({
  modo: z.enum(['guiado', 'livre']).optional(),
  nome: z.string().trim().max(40).nullable().optional(),
  personalidade: z.string().trim().max(1000).nullable().optional(),
  boas_vindas: z.string().trim().max(300).nullable().optional(),
  temperatura: z.coerce.number().min(0).max(1).optional(),
  resumo_profissionais_ativo: z.boolean().optional(),
  resumo_profissionais_horario: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido (use HH:MM)').nullable().optional()
});

// --- dominioCustomizado.js ---

const dominioCustomizadoSchema = z.object({
  dominio: z.string().trim().toLowerCase().max(253)
    .regex(/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, 'Informe um domínio válido, ex: agenda.suaempresa.com.br')
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

// --- superAdmin.js / superAdminPlataforma.js ---

const superAdminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(1, 'Senha é obrigatória')
});

// Novos super admins só podem ser criados por quem já é super admin (ver
// routes/superAdmin.js), e só com e-mail @schednext.com.br — evita que alguém crie um
// acesso de dono da plataforma com um e-mail pessoal qualquer.
const superAdminCriarSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido')
    .refine((v) => v.endsWith('@schednext.com.br'), 'O e-mail precisa ser do domínio @schednext.com.br'),
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres'),
  // Reautenticação de quem está criando (não da conta nova): exige a senha de QUEM ESTÁ
  // LOGADO pra confirmar essa ação, senão um painel deixado aberto/desbloqueado por acidente
  // vira uma porta pra qualquer um criar seu próprio acesso de dono da plataforma (ver
  // routes/superAdmin.js, que compara isso com o hash do req.superAdmin.id).
  senha_atual: z.string().min(1, 'Confirme sua senha atual para continuar'),
  // Opcional — mesmo padrão de foto do resto do sistema (data URI base64 já redimensionada no
  // navegador, ver sql/2026_super_admins_foto.sql).
  foto_url: z.string().trim().optional().nullable()
});

// Edição do PRÓPRIO perfil (ver PUT /super-admin/super-admins/me em routes/superAdmin.js) — um
// super admin só edita a própria conta, nunca a de outro, então nem recebe :id na rota. email e
// senha são opcionais (o formulário só manda o que mudou), mas senha_atual é sempre obrigatória,
// mesma trava de reautenticação da criação.
const superAdminEditarSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido')
    .refine((v) => v.endsWith('@schednext.com.br'), 'O e-mail precisa ser do domínio @schednext.com.br')
    .optional(),
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').optional(),
  senha_atual: z.string().min(1, 'Confirme sua senha atual para continuar'),
  foto_url: z.string().trim().optional().nullable()
});

const leadStatusSchema = z.object({
  status: z.enum(['novo', 'contatado', 'fechado'])
});

// Ajuste manual da data de próxima cobrança da assinatura DA PLATAFORMA (não confundir com
// vencimentoAssinaturaSchema, que é do cliente final de uma barbearia) — usado pelo admin
// absoluto pra dar carência, corrigir uma data errada, etc. nullable pra também dar pra "zerar"
// (empresa sem cobrança recorrente ativa).
const empresaVencimentoSchema = z.object({
  proxima_cobranca_em: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida').nullable()
});

const empresaTrocarPlanoSchema = z.object({
  plano_plataforma_id: idLike
});

// Corrige o tipo de negócio de uma empresa cadastrada errada (ver POST /empresas/registrar em
// routes/empresasPublico.js, onde o dono escolhe isso uma vez, no cadastro) — admin absoluto
// pode ajustar depois sem precisar excluir e recriar a conta.
const empresaTrocarVerticalSchema = z.object({
  vertical: verticalEnum
});

// --- superAdminFinanceiro.js (contas a pagar/receber, ver sql/2026_contas_pagar_receber.sql) ---

const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida');
const formaPagamentoContaEnum = z.enum(['pix', 'ted', 'boleto', 'dinheiro', 'cartao', 'outro']).optional().nullable();
// Competência = mês/ano de referência financeira (regime de competência), separado da data de
// vencimento/pagamento (regime de caixa) — ver sql/2026_contas_competencia.sql. Input do
// frontend é <input type="month"> ("AAAA-MM"), convertido aqui pro dia 1 do mês pra bater com a
// coluna DATE do banco.
const competenciaSchema = z.string().regex(/^\d{4}-\d{2}$/, 'Competência inválida (use mês/ano)').transform((v) => `${v}-01`);

const contaPagarSchema = z.object({
  descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(200),
  categoria: textoOpcionalNullable,
  beneficiario_nome: z.string().trim().min(1, 'Nome do beneficiário é obrigatório').max(150),
  beneficiario_documento: textoOpcionalNullable,
  forma_pagamento: formaPagamentoContaEnum,
  chave_pix: textoOpcionalNullable,
  banco: textoOpcionalNullable,
  agencia: textoOpcionalNullable,
  conta: textoOpcionalNullable,
  valor: z.coerce.number().min(0, 'Valor não pode ser negativo'),
  competencia: competenciaSchema,
  data_vencimento: dataSchema,
  observacoes: textoOpcionalNullable
});

const contaPagarBaixaSchema = z.object({
  data_pagamento: dataSchema.optional()
});

const contaReceberSchema = z.object({
  empresa_id: idLikeNullable,
  pagador_nome: z.string().trim().min(1, 'Nome do pagador é obrigatório').max(150),
  pagador_email: z.string().trim().email('E-mail inválido').optional().nullable().or(z.literal('')),
  descricao: z.string().trim().min(1, 'Descrição é obrigatória').max(200),
  valor: z.coerce.number().min(0, 'Valor não pode ser negativo'),
  competencia: competenciaSchema,
  data_prevista: dataSchema,
  forma_pagamento: formaPagamentoContaEnum,
  observacoes: textoOpcionalNullable
});

const contaReceberBaixaSchema = z.object({
  data_recebimento: dataSchema.optional()
});

// Dados de identificação/endereço exigidos pela API de boleto do Mercado Pago (ver
// services/mercadopago.js:criarPagamentoBoleto) — gravados na própria conta a receber pra não
// pedir de novo numa próxima emissão.
const contaReceberBoletoSchema = z.object({
  pagador_documento: z.string().trim().regex(/^\d{11}$|^\d{14}$/, 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos), só números'),
  pagador_cep: z.string().trim().regex(/^\d{8}$/, 'CEP inválido, só números (8 dígitos)'),
  pagador_endereco: z.string().trim().min(1, 'Endereço é obrigatório').max(150),
  pagador_numero: z.string().trim().min(1, 'Número é obrigatório').max(20),
  pagador_bairro: z.string().trim().min(1, 'Bairro é obrigatório').max(100),
  pagador_cidade: z.string().trim().min(1, 'Cidade é obrigatória').max(100),
  pagador_uf: z.string().trim().length(2, 'UF deve ter 2 letras')
});

const contaReceberEnviarCobrancaSchema = z.object({
  mensagem: textoOpcionalNullable
});

// Mês/ano cru ("AAAA-MM"), sem o transform pro dia 1 que competenciaSchema aplica — o lançamento
// em massa precisa das partes ano/mês separadas pra calcular a data prevista de cada empresa.
const lancamentoEmMassaSchema = z.object({
  competencia: z.string().regex(/^\d{4}-\d{2}$/, 'Competência inválida (use mês/ano)')
});

// Configuração genérica da plataforma (ver sql/2026_plataforma_configuracoes.sql) — chave/valor
// livre, então a validação aqui é só de forma, não de conteúdo (cada chave decide seu próprio
// formato de valor no lugar que a lê).
const plataformaConfiguracaoSchema = z.object({
  chave: z.string().trim().min(1).max(100),
  valor: z.string().trim().max(500).optional().nullable()
});

// --- chavesAtivacao.js ---

const chaveAtivacaoCriarSchema = z.object({
  plano_plataforma_id: idLike,
  duracao_dias: z.coerce.number().int().positive('Duração precisa ser maior que zero').max(3650, 'Duração máxima de 10 anos'),
  quantidade: z.coerce.number().int().positive().max(50, 'No máximo 50 chaves por vez').optional().default(1),
  observacao: textoOpcionalNullable,
  prazo_resgate_dias: z.coerce.number().int().positive().max(3650).optional().nullable()
});

const chaveAtivacaoResgatarSchema = z.object({
  codigo: z.string().trim().min(4, 'Informe o código da chave').max(40)
});

const planoPlataformaSchema = z.object({
  nome: z.string().trim().min(1, 'Nome do plano é obrigatório').max(100),
  preco_mensal: z.coerce.number().min(0).nullable(),
  limite_profissionais: z.coerce.number().int().positive().nullable(),
  limite_agendamentos_mes: z.coerce.number().int().positive().nullable(),
  limite_admins: z.coerce.number().int().positive().nullable().optional(),
  permite_paleta_customizada: z.boolean().optional().default(false),
  permite_whatsapp_bot: z.boolean().optional().default(false),
  permite_remover_marca: z.boolean().optional().default(false),
  permite_ia: z.boolean().optional().default(false),
  permite_multi_unidade: z.boolean().optional().default(false),
  permite_api_publica: z.boolean().optional().default(false),
  permite_relatorios_avancados: z.boolean().optional().default(false),
  permite_dominio_customizado: z.boolean().optional().default(false),
  // Fatia (application_fee) que a SchedNext fica de cada Pix cobrado via Mercado Pago nesse
  // plano — ver utils/limitesPlano.js (obterTaxaMarketplace) e routes/mercadopago.js.
  taxa_marketplace_percentual: z.coerce.number().min(0, 'Taxa não pode ser negativa').max(100, 'Taxa não pode passar de 100%').optional().default(0),
  // Liga/desliga (ativo=false some do site e ninguém contrata), plano oculto (publico=false só
  // o admin absoluto aplica) e dias de teste (null = sem limite). Ver
  // sql/2026_planos_ativo_trial_antifraude.sql.
  ativo: z.boolean().optional(),
  publico: z.boolean().optional(),
  dias_teste: z.coerce.number().int().positive('Dias de teste deve ser maior que zero').nullable().optional()
});

const planoAtivoSchema = z.object({ ativo: z.boolean() });

// Área de teste de planos: aplica um plano (mesmo desligado/oculto) numa empresa escolhida por
// alguns dias; ao acabar, ela volta ao plano anterior (cron/assinaturas.js).
const planoTesteSchema = z.object({
  empresa_id: idLike,
  plano_plataforma_id: idLike,
  dias: z.coerce.number().int().min(1, 'Mínimo 1 dia').max(90, 'Máximo 90 dias')
});

module.exports = {
  registrarSchema,
  loginSchema,
  loginClienteSchema,
  loginMagicoSchema,
  suporteMensagemSchema,
  suporteRepassarSchema,
  agendarSchema,
  clienteRapidoSchema,
  registrarEmpresaSchema,
  confirmarCodigoSchema,
  recuperarSenhaSchema,
  resetarSenhaSchema,
  recuperarSenhaAdminSchema,
  segurancaCodigoSchema,
  segurancaUpdateSchema,
  segurancaValidarSchema,
  perfilAtualizarSchema,
  avaliarSchema,
  empresaAtualizarSchema,
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
  unidadeAdminCriarSchema,
  clienteAtualizarSchema,
  clienteAssinanteSchema,
  clienteFollowupSchema,
  encaixeSchema,
  finalizarEncaixeCompletoSchema,
  confirmarAgendamentoSchema,
  cancelarAgendamentoSchema,
  finalizarCheckoutSchema,
  agendarEncaixeSchema,
  reagendarAgendamentoSchema,
  acaoFidelidadeSchema,
  acaoStatusSchema,
  assinaturaPlanoSchema,
  clientePlanoSchema,
  iniciarUpgradeSchema,
  apiKeyCriarSchema,
  taxasPagamentoSchema,
  mercadoPagoPixSchema,
  assinarAssinaturaSchema,
  baixaManualAssinaturaSchema,
  vencimentoAssinaturaSchema,
  apiPublicaAgendamentoSchema,
  whatsappTesteSchema,
  whatsappBotConfigSchema,
  dominioCustomizadoSchema,
  contatoEnterpriseSchema,
  superAdminLoginSchema,
  superAdminCriarSchema,
  leadStatusSchema,
  empresaVencimentoSchema,
  empresaTrocarPlanoSchema,
  empresaTrocarVerticalSchema,
  contaPagarSchema,
  contaPagarBaixaSchema,
  contaReceberSchema,
  contaReceberBaixaSchema,
  contaReceberBoletoSchema,
  contaReceberEnviarCobrancaSchema,
  lancamentoEmMassaSchema,
  plataformaConfiguracaoSchema,
  superAdminEditarSchema,
  planoPlataformaSchema,
  planoAtivoSchema,
  planoTesteSchema,
  chaveAtivacaoCriarSchema,
  chaveAtivacaoResgatarSchema
};
