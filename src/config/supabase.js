const { createClient } = require('@supabase/supabase-js');

// Backend é sempre server-side/trusted, então usamos a service_role key deliberadamente
// (ela bypassa RLS). O isolamento multi-tenant continua sendo responsabilidade das
// próprias queries (sempre filtrando por empresa_id), igual já era com o MySQL.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

module.exports = supabase;
