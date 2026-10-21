import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createWebhookHandler } from "../_shared/webhook.mjs";

const handler = createWebhookHandler({
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
      async retrieveEvent(rawBody, signature, webhookSecret) {
        const event = await stripe.webhooks.constructEventAsync(
          rawBody,
          signature,
          webhookSecret,
          undefined,
          Stripe.createSubtleCryptoProvider()
        );
        const object = event.data.object;
        if (!("mode" in object)) throw new Error("Unexpected Stripe event object");
        return {
          id: event.id,
          type: event.type,
          data: { object: { ...object } }
        };
      },
      async getAttemptByKey(attemptKey) {
        const { data, error } = await supabase
          .from("checkout_sessions")
          .select("id, order_id, attempt_key, stripe_checkout_session_id")
          .eq("attempt_key", attemptKey)
          .maybeSingle();
        if (error) throw new Error("Could not load checkout attempt");
        return data;
      },
      async processEvent(input) {
        const { data, error } = await supabase.rpc("process_stripe_checkout_event", input);
        if (error || typeof data !== "string") {
          throw new Error("Could not process Stripe event");
        }
        return data;
      }
    };
  }
});

Deno.serve(handler);
