import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createCheckoutRecoveryHandler } from "../_shared/checkout.mjs";

const handler = createCheckoutRecoveryHandler({
  getEnv: (name) => Deno.env.get(name),
  createServices: async (config) => {
    const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      }
    });
    const stripe = new Stripe(config.stripeSecretKey, {
      httpClient: Stripe.createFetchHttpClient()
    });
    return {
      repository: {
        async createAttempt(input) {
          const { data, error } = await supabase.rpc("create_checkout_attempt", input);
          if (error || !Array.isArray(data) || data.length !== 1) {
            throw new Error("Could not create checkout attempt");
          }
          return data[0];
        },
        async recoverAttempt(input) {
          const { data, error } = await supabase.rpc("recover_guest_checkout_attempt", input);
          if (error) throw error;
          if (!Array.isArray(data) || data.length !== 1) throw new Error("Could not recover attempt");
          return data[0];
        },
        async getAttempt(attemptId) {
          const { data, error } = await supabase
            .from("checkout_sessions")
            .select("id, order_id, attempt_key, stripe_checkout_session_id, status, amount_total, currency, expires_at, customer_email")
            .eq("id", attemptId)
            .maybeSingle();
          if (error || !data) throw new Error("Could not load checkout attempt");
          return data;
        },
        async getOrderItems(orderId) {
          const { data, error } = await supabase
            .from("order_items")
            .select("product_id, product_name, quantity, unit_price")
            .eq("order_id", orderId)
            .order("id", { ascending: true });
          if (error || !data) throw new Error("Could not load order items");
          return data;
        },
        async attachSession(attemptKey, sessionId, expiresAt) {
          const { error } = await supabase.rpc("attach_stripe_checkout_session", {
            p_attempt_key: attemptKey,
            p_stripe_session_id: sessionId,
            p_expires_at: expiresAt
          });
          if (error) throw new Error("Could not attach Checkout Session");
        },
        async registerCapabilities(input) {
          const { error } = await supabase.rpc("register_guest_checkout_capabilities", input);
          if (error) throw new Error("Could not register guest capabilities");
        },
        async consumeRateLimit(bucketHash, limit, windowSeconds) {
          const { data, error } = await supabase.rpc("consume_guest_checkout_rate_limit", {
            p_bucket_hash: bucketHash,
            p_limit: limit,
            p_window_seconds: windowSeconds
          });
          if (error || !Array.isArray(data) || data.length !== 1) {
            throw new Error("Could not enforce recovery rate limit");
          }
          return data[0];
        }
      },
      stripe: {
        async createSession(params, idempotencyKey) {
          const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
          return {
            id: session.id,
            url: session.url,
            status: session.status ?? "open",
            expires_at: session.expires_at
          };
        },
        async retrieveSession(sessionId) {
          const session = await stripe.checkout.sessions.retrieve(sessionId);
          return {
            id: session.id,
            url: session.url,
            status: session.status ?? "open",
            expires_at: session.expires_at
          };
        }
      }
    };
  }
});

Deno.serve(handler);
