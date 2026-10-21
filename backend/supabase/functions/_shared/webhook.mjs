// @ts-check

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const ATTEMPT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

class WebhookError extends Error {
  /** @param {number} status */
  constructor(status) {
    super("Invalid Stripe webhook request");
    this.status = status;
  }
}

/**
 * @typedef {{
 *   stripeSecretKey: string,
 *   webhookSecret: string,
 *   supabaseUrl: string,
 *   serviceRoleKey: string
 * }} WebhookConfig
 */

/**
 * @typedef {{
 *   id: string,
 *   order_id: string,
 *   attempt_key: string,
 *   stripe_checkout_session_id: string | null
 * }} WebhookAttempt
 */

/**
 * @typedef {{
 *   retrieveEvent: (rawBody: string, signature: string, webhookSecret: string) => Promise<{
 *     id: string,
 *     type: string,
 *     data: { object: Record<string, unknown> }
 *   }>,
 *   getAttemptByKey: (attemptKey: string) => Promise<WebhookAttempt | null>,
 *   processEvent: (input: Record<string, unknown>) => Promise<string>
 * }} WebhookServices
 */

/**
 * @param {(name: string) => string | undefined} getEnv
 * @returns {WebhookConfig}
 */
function readWebhookConfig(getEnv) {
  const required = (name) => {
    const value = getEnv(name)?.trim();
    if (!value) throw new Error("Missing webhook configuration");
    return value;
  };
  const supabaseUrl = required("SUPABASE_URL");
  if (!/^https?:\/\//.test(supabaseUrl)) throw new Error("Invalid webhook configuration");
  return {
    stripeSecretKey: required("STRIPE_SECRET_KEY"),
    webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    supabaseUrl,
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY")
  };
}

/**
 * @param {Request} request
 * @returns {Promise<string>}
 */
async function readRawBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WEBHOOK_BYTES)) {
    throw new WebhookError(413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new WebhookError(413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WebhookError(400);
  }
}

/**
 * @param {Record<string, unknown>} value
 */
function stringField(value, key) {
  return typeof value[key] === "string" ? /** @type {string} */ (value[key]) : null;
}

/**
 * @param {Record<string, unknown>} session
 */
function paymentIntentId(session) {
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent === "string") return paymentIntent;
  if (paymentIntent && typeof paymentIntent === "object" && !Array.isArray(paymentIntent)) {
    const id = (/** @type {Record<string, unknown>} */ (paymentIntent)).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/**
 * @param {string} eventId
 * @param {string} eventType
 * @param {Record<string, unknown>} session
 */
function sessionEventInput(eventId, eventType, session) {
  if (session.mode !== "payment") throw new WebhookError(400);
  const sessionId = stringField(session, "id");
  const amountTotal = session.amount_total;
  const currency = stringField(session, "currency");
  const metadataValue = session.metadata;
  const metadata = metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)
    ? /** @type {Record<string, unknown>} */ (metadataValue)
    : {};
  const attemptKey = stringField(metadata, "attempt_key");
  const orderId = stringField(metadata, "order_id");
  const attemptId = stringField(metadata, "checkout_attempt_id");
  const clientReferenceId = stringField(session, "client_reference_id");

  if (
    !sessionId ||
    !sessionId.startsWith("cs_") ||
    !Number.isSafeInteger(amountTotal) ||
    /** @type {number} */ (amountTotal) < 0 ||
    !currency ||
    !/^[a-z]{3}$/i.test(currency) ||
    !attemptKey ||
    !ATTEMPT_KEY_PATTERN.test(attemptKey) ||
    !orderId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId) ||
    !attemptId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId) ||
    clientReferenceId !== orderId
  ) {
    throw new WebhookError(400);
  }

  return {
    attemptKey,
    orderId,
    attemptId,
    sessionId,
    amountTotal: /** @type {number} */ (amountTotal),
    currency: currency.toUpperCase(),
    paymentIntentId: paymentIntentId(session)
  };
}

/**
 * @param {WebhookServices} services
 * @param {{ id: string, type: string, data: { object: Record<string, unknown> } }} event
 */
async function processStripeEvent(services, event) {
  if (
    typeof event.id !== "string" ||
    !event.id.startsWith("evt_") ||
    event.id.length > 255 ||
    typeof event.type !== "string"
  ) {
    throw new WebhookError(400);
  }
  const actionByType = {
    "checkout.session.completed": "paid",
    "checkout.session.async_payment_succeeded": "paid",
    "checkout.session.async_payment_failed": "failed",
    "checkout.session.expired": "expired"
  };
  const action = /** @type {Record<string, string | undefined>} */ (actionByType)[event.type];
  if (!action) return "ignored";

  const session = event.data.object;
  if (event.type === "checkout.session.completed" && session.payment_status !== "paid") {
    return "ignored";
  }
  if (
    event.type === "checkout.session.async_payment_succeeded" &&
    session.payment_status !== "paid"
  ) {
    throw new Error("Stripe asynchronous success is not marked paid");
  }

  const details = sessionEventInput(event.id, event.type, session);
  let attempt = null;
  try {
    attempt = await services.getAttemptByKey(details.attemptKey);
  } catch {
    throw new Error("Checkout attempt lookup failed");
  }

  if (
    !attempt ||
    attempt.id !== details.attemptId ||
    attempt.order_id !== details.orderId
  ) {
    const result = await services.processEvent({
      p_event_id: event.id,
      p_event_type: event.type,
      p_attempt_key: `unmatched-${event.id}`,
      p_stripe_session_id: details.sessionId,
      p_payment_intent_id: details.paymentIntentId,
      p_amount_total: details.amountTotal,
      p_currency: details.currency,
      p_action: action
    });
    return result;
  }

  return await services.processEvent({
    p_event_id: event.id,
    p_event_type: event.type,
    p_attempt_key: details.attemptKey,
    p_stripe_session_id: details.sessionId,
    p_payment_intent_id: details.paymentIntentId,
    p_amount_total: details.amountTotal,
    p_currency: details.currency,
    p_action: action
  });
}

/**
 * @param {{
 *   getEnv: (name: string) => string | undefined,
 *   createServices: (config: WebhookConfig) => Promise<WebhookServices>
 * }} dependencies
 */
export function createWebhookHandler(dependencies) {
  return async (request) => {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }

    try {
      const config = readWebhookConfig(dependencies.getEnv);
      const signature = request.headers.get("stripe-signature");
      if (!signature) throw new WebhookError(400);
      const rawBody = await readRawBody(request);
      const services = await dependencies.createServices(config);
      let event;
      try {
        event = await services.retrieveEvent(rawBody, signature, config.webhookSecret);
      } catch {
        throw new WebhookError(400);
      }

      const result = await processStripeEvent(services, event);
      if (["mismatch", "unmatched", "reconciliation_required"].includes(result)) {
        console.error("Verified Stripe event requires checkout reconciliation");
      }
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    } catch (error) {
      const status = error instanceof WebhookError ? error.status : 503;
      if (!(error instanceof WebhookError)) {
        console.error("Stripe webhook processing operation failed");
      }
      return new Response(JSON.stringify({
        error: status === 400 || status === 413
          ? "Invalid webhook request."
          : "Webhook processing is temporarily unavailable."
      }), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }
  };
}
