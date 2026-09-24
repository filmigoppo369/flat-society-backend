// 1. Load the Supabase library
const { createClient } = require('@supabase/supabase-js');

// 2. Load values from .env file (SUPABASE_URL, keys, etc.)
require('dotenv').config();

// 3. Read the two values from .env into local variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 4. Safety check: if .env is missing or incomplete, stop immediately
//    with a clear error instead of a confusing error later
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
}

// 5. Create the Supabase client (the "connection object")
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,   // backend doesn't log in as a user,
    persistSession: false      // so don't save any session on disk
  }
});

// 6. Export it so other files can do: require('./lib/supabase')
module.exports = supabase;