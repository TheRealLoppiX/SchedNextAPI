const { z } = require('zod');

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
  usuario_id: z.union([z.string(), z.number()]),
  barbeiro_id: z.union([z.string(), z.number()]),
  empresa_slug: z.string().trim().min(1),
  data_hora: z.string().min(1),
  servicos: z.array(z.object({ id: z.union([z.string(), z.number()]) })).min(1, 'Selecione ao menos um serviço'),
  unidade_id: z.union([z.string(), z.number()]).optional().nullable()
});

const clienteRapidoSchema = z.object({
  nome: z.string().trim().min(2, 'Nome é obrigatório'),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(3, 'Senha é obrigatória'),
  tel: z.string().trim().min(8, 'Telefone é obrigatório'),
  nasc: z.string().optional().nullable(),
  empresa_id: z.union([z.string(), z.number()])
});

const registrarEmpresaSchema = z.object({
  nome: z.string().trim().min(2, 'Nome muito curto').max(150),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/, 'Use apenas letras minúsculas, números e hífen').min(3).max(60),
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  senha: z.string().min(6, 'Senha deve ter ao menos 6 caracteres').max(100),
  vertical: z.enum(['barbearia', 'salao', 'estudio_unhas', 'generico']),
  plano_plataforma_id: z.union([z.string(), z.number()]).optional()
});

module.exports = { registrarSchema, loginSchema, agendarSchema, clienteRapidoSchema, registrarEmpresaSchema };
