import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createGuestStatusHandler } from "../_shared/guest-access.mjs";

const handler = createGuestStatusHandler({
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
          throw new Error("Guest status rate limit failed");
        }
        return data[0];
      }
    };
  }
});

Deno.serve(handler);
