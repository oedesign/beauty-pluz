import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const config = window.BEAUTY_PLUZ_BACKEND_CONFIG || {};

export const publicSupabase = config.supabaseUrl && config.supabaseAnonKey
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    })
  : null;
