import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const config = window.BEAUTY_PLUZ_BACKEND_CONFIG || {};

export const supabase = config.supabaseUrl && config.supabaseAnonKey
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        storage: window.sessionStorage,
        storageKey: "beautypluz-admin-auth",
      },
    })
  : null;

export async function verifyAdminSession() {
  if (!supabase) throw new Error("The store backend is not configured.");
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) return null;

  const { data: isAdmin, error: authorizationError } = await supabase.rpc("is_beautypluz_admin");
  if (authorizationError) throw authorizationError;
  return isAdmin === true ? data.session : null;
}
