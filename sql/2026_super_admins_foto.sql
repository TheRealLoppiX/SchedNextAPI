-- Foto de perfil opcional pro super admin (dono da plataforma), mostrada como avatar na aba
-- "Super Admins" do admin absoluto em vez das iniciais do e-mail. Mesmo padrão do resto do
-- projeto pra foto de perfil (ver empresas.logo_url, usuarios.foto_url, barbeiros.foto_url):
-- o front redimensiona a imagem no navegador e manda como data URI base64, sem upload pra
-- nenhum storage externo, então basta uma coluna de texto.
--
-- Rodado via SQL editor/Management API do Supabase, mesmo padrão do resto do projeto (sem
-- migration runner).

ALTER TABLE super_admins
  ADD COLUMN IF NOT EXISTS foto_url text;
