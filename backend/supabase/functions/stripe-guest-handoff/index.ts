import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createGuestHandoffHandler } from "../_shared/guest-access.mjs";

const handler = createGuestHandoffHandler({
  getEnv: (name) => Deno.env.get(name),
  createServices: async (config) => {
    const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      }
    });
    return {
      async exchangeHandoff(hash) {
        const { data, error } = await supabase.rpc("exchange_guest_checkout_handoff", {
          p_handoff_hash: hash
        });
        if (error) throw new Error("Guest handoff exchange failed");
        return Array.isArray(data) && data.length === 1 ? data[0] : null;
      },
      async getStatus(hash) {
        const { data, error } = await supabase.rpc("get_guest_checkout_status", {
          p_status_hash: hash
        });
        if (error) throw new Error("Guest order status lookup failed");
        return Array.isArray(data) && data.length === 1 ? data[0] : null;
      },
      async consumeRateLimit(hash, limit, windowSeconds) {
        const { data, error } = await supabase.rpc("consume_guest_checkout_rate_limit", {
          p_bucket_hash: hash,
          p_limit: limit,
          p_window_seconds: windowSeconds
        });
        if (error || !Array.isArray(data) || data.length !== 1) {
          throw new Error("Guest handoff rate limit failed");
        }
        return data[0];
      }
    };
  }
});

Deno.serve(handler);
