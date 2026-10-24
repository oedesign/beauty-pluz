// @ts-check
import {
  appendHandoffFragment,
  consumeCheckoutRateLimits,
  deriveGuestCapability,
  hashGuestCapability,
  hashRateLimitKey
} from "./guest-access.mjs";
import { gatewayAuthFailure, verifyGatewayRequest } from "./gateway-auth.mjs";

const MAX_REQUEST_BYTES = 16 * 1024;
const CHECKOUT_LIFETIME_MS = 60 * 60 * 1000;
const MIN_STRIPE_SESSION_LIFETIME_SECONDS = 30 * 60;

class RequestError extends Error {
  /** @param {number} status @param {number} retryAfter */
  constructor(status, retryAfter = 0) {
    super("Invalid checkout request");
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/**
 * @typedef {{
 *   stripeSecretKey: string,
 *   supabaseUrl: string,
 *   serviceRoleKey: string,
 *   capabilitySecret: string,
 *   rateLimitSecret: string,
 *   successUrl: string,
 *   cancelUrl: string,
 *   allowedOrigins: string[],
 *   deliveryFeePence: number
 * }} CheckoutConfig
 */

/**
 * @typedef {{
 *   id: string,
 *   order_id: string,
 *   attempt_key: string,
 *   stripe_checkout_session_id: string | null,
 *   status: string,
 *   amount_total: number | string,
 *   currency: string,
 *   expires_at: string,
 *   customer_email: string
 * }} CheckoutAttempt
 */

/**
 * @typedef {{
 *   product_id: string,
 *   product_name: string,
 *   quantity: number,
 *   unit_price: number | string
 * }} OrderItem
 */

/**
 * @typedef {{
 *   id: string,
 *   url: string | null,
 *   status: string,
 *   expires_at: number
 * }} StripeCheckoutSession
 */

/**
 * @typedef {{
 *   mode: "payment",
 *   line_items: Array<{
 *     price_data: {
 *       currency: "gbp",
 *       product_data: { name: string },
 *       unit_amount: number
 *     },
 *     quantity: number
 *   }>,
 *   success_url: string,
 *   cancel_url: string,
 *   expires_at: number,
 *   customer_email: string,
 *   client_reference_id: string,
 *   metadata: Record<string, string>,
 *   payment_intent_data: { metadata: Record<string, string> }
 * }} StripeCheckoutParams
 */

/**
 * @typedef {{
 *   createAttempt: (input: Record<string, unknown>) => Promise<{
 *     order_id: string,
 *     attempt_id: string,
 *     amount_total: number | string,
 *     currency: string,
 *     reused: boolean
 *   }>,
 *   getAttempt: (attemptId: string) => Promise<CheckoutAttempt>,
 *   getOrderItems: (orderId: string) => Promise<OrderItem[]>,
 *   attachSession: (attemptKey: string, sessionId: string, expiresAt: string) => Promise<void>
 *   registerCapabilities: (input: Record<string, unknown>) => Promise<void>,
 *   consumeRateLimit: (hash: string, limit: number, windowSeconds: number) => Promise<{
 *     allowed: boolean,
 *     retry_after_seconds: number
 *   }>,
 *   recoverAttempt?: (input: Record<string, unknown>) => Promise<{
 *     order_id: string,
 *     attempt_id: string,
 *     amount_total: number | string,
 *     currency: string,
 *     reused: boolean
 *   }>
 * }} CheckoutRepository
 */

/**
 * @typedef {{
 *   createSession: (params: StripeCheckoutParams, idempotencyKey: string) => Promise<StripeCheckoutSession>,
 *   retrieveSession: (sessionId: string) => Promise<StripeCheckoutSession>
 * }} CheckoutStripe
 */

/**
 * @param {string} value
 * @param {string[]} allowedOrigins
 * @param {boolean} needsSessionPlaceholder
 */
function validateReturnUrl(value, allowedOrigins, needsSessionPlaceholder) {
  if (needsSessionPlaceholder && !value.includes("{CHECKOUT_SESSION_ID}")) {
    throw new Error("Invalid checkout configuration");
  }

  const url = new URL(value);
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedOrigins.includes(url.origin)
  ) {
    throw new Error("Invalid checkout configuration");
  }
}

/**
 * @param {(name: string) => string | undefined} getEnv
 * @returns {CheckoutConfig}
 */
function readCheckoutConfig(getEnv) {
  const required = (name) => {
    const value = getEnv(name)?.trim();
    if (!value) throw new Error("Missing checkout configuration");
    return value;
  };
  const allowedOrigins = required("CHECKOUT_ALLOWED_ORIGINS")
    .split(",")
    .map((origin) => {
      const url = new URL(origin.trim());
      const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (
        (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) ||
        url.origin !== origin.trim() ||
        url.username ||
        url.password
      ) {
        throw new Error("Invalid checkout configuration");
      }
      return url.origin;
    });
  if (allowedOrigins.length === 0 || new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new Error("Invalid checkout configuration");
  }

  const deliveryFeeRaw = required("CHECKOUT_DELIVERY_FEE_PENCE");
  if (!/^\d{1,8}$/.test(deliveryFeeRaw)) throw new Error("Invalid checkout configuration");
  const deliveryFeePence = Number(deliveryFeeRaw);
  if (deliveryFeePence > 10000000) throw new Error("Invalid checkout configuration");

  const successUrl = required("CHECKOUT_SUCCESS_URL");
  const cancelUrl = required("CHECKOUT_CANCEL_URL");
  validateReturnUrl(successUrl, allowedOrigins, true);
  validateReturnUrl(cancelUrl, allowedOrigins, false);

  const supabaseUrl = required("SUPABASE_URL");
  if (!/^https?:\/\//.test(supabaseUrl)) throw new Error("Invalid checkout configuration");
  const capabilitySecret = required("CHECKOUT_CAPABILITY_SECRET");
  const rateLimitSecret = required("CHECKOUT_RATE_LIMIT_SECRET");
  if (capabilitySecret.length < 32 || rateLimitSecret.length < 32) {
    throw new Error("Invalid checkout configuration");
  }

  return {
    stripeSecretKey: required("STRIPE_SECRET_KEY"),
    supabaseUrl,
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    capabilitySecret,
    rateLimitSecret,
    successUrl,
    cancelUrl,
    allowedOrigins,
    deliveryFeePence
  };
}

/**
 * @param {Request} request
 * @returns {Promise<string>}
 */
async function readLimitedBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
    throw new RequestError(413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestError(413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RequestError(400);
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} allowed
 */
function rejectUnknownFields(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RequestError(400);
}

/**
 * @param {unknown} body
 */
function validateCheckoutBody(body) {
  const root = asRecord(body);
  rejectUnknownFields(root, ["idempotencyKey", "customer", "items"]);

  const idempotencyKey = root.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey)) {
    throw new RequestError(400);
  }

  const customer = asRecord(root.customer);
  rejectUnknownFields(customer, ["name", "email", "phone", "shippingAddress"]);
  const name = typeof customer.name === "string" ? customer.name.trim() : "";
  const email = typeof customer.email === "string" ? customer.email.trim().toLowerCase() : "";
  const phone = customer.phone === undefined || customer.phone === null
    ? null
    : typeof customer.phone === "string" ? customer.phone.trim() : "";
  const shippingAddress = typeof customer.shippingAddress === "string"
    ? customer.shippingAddress.trim()
    : "";

  if (
    name.length < 1 ||
    name.length > 180 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (phone !== null && (phone.length > 40 || !/^[+0-9().\-\s]{7,40}$/.test(phone))) ||
    shippingAddress.length < 5 ||
    shippingAddress.length > 1000
  ) {
    throw new RequestError(400);
  }

  if (!Array.isArray(root.items) || root.items.length < 1 || root.items.length > 50) {
    throw new RequestError(400);
  }
  const seen = new Set();
  const items = root.items.map((entry) => {
    const item = asRecord(entry);
    rejectUnknownFields(item, ["productId", "quantity"]);
    const productId = typeof item.productId === "string" ? item.productId.trim() : "";
    if (
      productId.length < 1 ||
      productId.length > 180 ||
      !Number.isInteger(item.quantity) ||
      /** @type {number} */ (item.quantity) < 1 ||
      /** @type {number} */ (item.quantity) > 100 ||
      seen.has(productId)
    ) {
      throw new RequestError(400);
    }
    seen.add(productId);
    return { product_id: productId, quantity: item.quantity };
  });

  return {
    idempotencyKey,
    customer: { name, email, phone, shippingAddress },
    items
  };
}

/**
 * @param {number | string} value
 */
function safeInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid database amount");
  return number;
}

/**
 * @param {number | string} value
 */
function priceToPence(value) {
  const text = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error("Invalid database price");
  const pounds = Number(match[1]);
  const pence = Number((match[2] ?? "").padEnd(2, "0"));
  const result = pounds * 100 + pence;
  if (!Number.isSafeInteger(result)) throw new Error("Invalid database price");
  return result;
}

/**
 * @param {CheckoutConfig} config
 * @param {CheckoutRepository} repository
 * @param {CheckoutStripe} stripe
 */
async function createStripeSession(config, repository, stripe, attempt, attemptKey, handoffToken, now = Date.now()) {
  if (attempt.stripe_checkout_session_id) {
    const existingSession = await stripe.retrieveSession(attempt.stripe_checkout_session_id);
    if (
      existingSession.status === "open" &&
      existingSession.url &&
      existingSession.expires_at * 1000 > now
    ) {
      return existingSession.url;
    }
    throw new RequestError(409);
  }
  if (attempt.status !== "creating") throw new RequestError(409);

  const expiresAtMs = Date.parse(attempt.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) throw new RequestError(409);
  const expiresAt = Math.floor(expiresAtMs / 1000);
  if (expiresAt - Math.floor(now / 1000) < MIN_STRIPE_SESSION_LIFETIME_SECONDS) {
    throw new RequestError(409);
  }

  const orderItems = await repository.getOrderItems(attempt.order_id);
  if (orderItems.length < 1 || orderItems.length > 50) throw new Error("Invalid order items");

  const lineItems = orderItems.map((line) => {
    if (
      !line.product_name ||
      line.product_name.length > 180 ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 100
    ) {
      throw new Error("Invalid order item snapshot");
    }
    return {
      price_data: {
        currency: "gbp",
        product_data: { name: line.product_name },
        unit_amount: priceToPence(line.unit_price)
      },
      quantity: line.quantity
    };
  });
  const itemSubtotal = lineItems.reduce(
    (total, line) => total + line.price_data.unit_amount * line.quantity,
    0
  );
  const expectedTotal = safeInteger(attempt.amount_total);
  const deliveryFeePence = expectedTotal - itemSubtotal;
  if (
    !Number.isSafeInteger(itemSubtotal) ||
    !Number.isSafeInteger(deliveryFeePence) ||
    deliveryFeePence < 0 ||
    itemSubtotal + deliveryFeePence !== expectedTotal
  ) {
    throw new Error("Order amount does not match its item snapshots");
  }
  if (deliveryFeePence > 0) {
    lineItems.push({
      price_data: {
        currency: "gbp",
        product_data: { name: "Delivery" },
        unit_amount: deliveryFeePence
      },
      quantity: 1
    });
  }

  const stableMetadata = {
    order_id: attempt.order_id,
    checkout_attempt_id: attempt.id,
    attempt_key: attemptKey
  };
  const session = await stripe.createSession({
    mode: "payment",
    line_items: lineItems,
    success_url: appendHandoffFragment(config.successUrl, handoffToken),
    cancel_url: appendHandoffFragment(config.cancelUrl, handoffToken),
    expires_at: expiresAt,
    customer_email: attempt.customer_email,
    client_reference_id: attempt.order_id,
    metadata: stableMetadata,
    payment_intent_data: { metadata: stableMetadata }
  }, `beautypluz-checkout-${attempt.id}`);

  if (
    !session.id.startsWith("cs_") ||
    !session.url ||
    !Number.isInteger(session.expires_at) ||
    session.expires_at <= Math.floor(now / 1000) ||
    session.expires_at > expiresAt
  ) {
    throw new Error("Stripe returned an invalid Checkout Session");
  }
  await repository.attachSession(
    attemptKey,
    session.id,
    new Date(session.expires_at * 1000).toISOString()
  );
  return session.url;
}

async function registerGuestCapabilities(config, repository, orderId, attemptId) {
  const handoffToken = await deriveGuestCapability(config.capabilitySecret, "handoff", attemptId);
  const statusToken = await deriveGuestCapability(config.capabilitySecret, "status", orderId);
  const recoveryToken = await deriveGuestCapability(config.capabilitySecret, "recovery", orderId);
  const [handoffHash, statusHash, recoveryHash] = await Promise.all([
    hashGuestCapability(handoffToken),
    hashGuestCapability(statusToken),
    hashGuestCapability(recoveryToken)
  ]);
  await repository.registerCapabilities({
    p_order_id: orderId,
    p_checkout_attempt_id: attemptId,
    p_handoff_hash: handoffHash,
    p_status_hash: statusHash,
    p_recovery_hash: recoveryHash,
    p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  return handoffToken;
}

async function createCheckout(config, repository, stripe, input, now = Date.now()) {
  const holdExpiresAt = new Date(now + CHECKOUT_LIFETIME_MS).toISOString();
  const attemptResult = await repository.createAttempt({
    p_attempt_key: input.idempotencyKey,
    p_order_id: null,
    p_customer_name: input.customer.name,
    p_customer_email: input.customer.email,
    p_customer_phone: input.customer.phone,
    p_shipping_address: input.customer.shippingAddress,
    p_items: input.items,
    p_delivery_fee_pence: config.deliveryFeePence,
    p_hold_expires_at: holdExpiresAt
  });
  const attempt = await repository.getAttempt(attemptResult.attempt_id);
  if (
    attempt.id !== attemptResult.attempt_id ||
    attempt.order_id !== attemptResult.order_id ||
    attempt.attempt_key !== input.idempotencyKey ||
    attempt.currency !== "GBP" ||
    safeInteger(attempt.amount_total) !== safeInteger(attemptResult.amount_total)
  ) {
    throw new Error("Checkout attempt data mismatch");
  }
  const handoffToken = await registerGuestCapabilities(config, repository, attempt.order_id, attempt.id);
  return createStripeSession(config, repository, stripe, attempt, input.idempotencyKey, handoffToken, now);
}

/**
 * @param {{
 *   getEnv: (name: string) => string | undefined,
 *   createServices: (config: CheckoutConfig) => Promise<{ repository: CheckoutRepository, stripe: CheckoutStripe }>
 * }} dependencies
 */
export function createCheckoutHandler(dependencies) {
  return async (request) => {
    let origin = null;
    try {
      const gatewayAuth = await verifyGatewayRequest(request, dependencies.getEnv, {
        consumeNonce: dependencies.consumeGatewayNonce
      });
      if (gatewayAuth !== "authorized") return gatewayAuthFailure(gatewayAuth);
      const config = readCheckoutConfig(dependencies.getEnv);
      origin = request.headers.get("origin");
      if (origin && !config.allowedOrigins.includes(origin)) {
        return new Response(null, { status: 403 });
      }

      const headers = new Headers({
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Expose-Headers": "Retry-After",
        "Cache-Control": "no-store",
        "Vary": "Origin"
      });
      if (origin) headers.set("Access-Control-Allow-Origin", origin);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: new Headers([...headers, ["Content-Type", "application/json"]])
        });
      }

      const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") throw new RequestError(415);
      const rawBody = await readLimitedBody(request);
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new RequestError(400);
      }
      const input = validateCheckoutBody(body);
      const { repository, stripe } = await dependencies.createServices(config);
      const rate = await consumeCheckoutRateLimits(
        repository,
        config,
        input.customer.email,
        input.idempotencyKey
      );
      if (!rate.allowed) throw new RequestError(429, rate.retryAfter);
      const url = await createCheckout(config, repository, stripe, input);
      return new Response(JSON.stringify({ url }), {
        status: 200,
        headers: new Headers([...headers, ["Content-Type", "application/json"]])
      });
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 503;
      if (!(error instanceof RequestError)) {
        console.error("Stripe checkout operation failed");
      }
      const headers = new Headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "Vary": "Origin"
      });
      if (origin) headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "content-type");
      headers.set("Access-Control-Expose-Headers", "Retry-After");
      if (status === 429 && error instanceof RequestError) {
        headers.set("Retry-After", String(Math.max(1, error.retryAfter)));
      }
      return new Response(JSON.stringify({
        error: status === 429
          ? "Too many checkout attempts. Please wait and try again."
          : status === 409
          ? "This checkout attempt is no longer available. Start a new checkout."
          : status === 400 || status === 413 || status === 415
            ? "Invalid checkout request."
            : "Checkout is temporarily unavailable."
      }), { status, headers });
    }
  };
}

/**
 * @param {{
 *   getEnv: (name: string) => string | undefined,
 *   createServices: (config: CheckoutConfig) => Promise<{ repository: CheckoutRepository, stripe: CheckoutStripe }>
 * }} dependencies
 */
export function createCheckoutRecoveryHandler(dependencies) {
  return async (request) => {
    let config;
    let origin = request.headers.get("origin");
    try {
      const gatewayAuth = await verifyGatewayRequest(request, dependencies.getEnv, {
        consumeNonce: dependencies.consumeGatewayNonce
      });
      if (gatewayAuth !== "authorized") return gatewayAuthFailure(gatewayAuth);
      config = readCheckoutConfig(dependencies.getEnv);
      const headers = new Headers({
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Expose-Headers": "Retry-After",
        "Cache-Control": "no-store",
        "Vary": "Origin"
      });
      if (origin && !config.allowedOrigins.includes(origin)) return new Response(null, { status: 403 });
      if (origin) headers.set("Access-Control-Allow-Origin", origin);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: new Headers([...headers, ["Content-Type", "application/json"]])
        });
      }
      const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") throw new RequestError(415);
      const rawBody = await readLimitedBody(request);
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new RequestError(400);
      }
      const root = asRecord(body);
      rejectUnknownFields(root, ["recoveryToken"]);
      if (
        typeof root.recoveryToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(root.recoveryToken)
      ) {
        throw new RequestError(400);
      }

      const { repository, stripe } = await dependencies.createServices(config);
      const recoveryHash = await hashGuestCapability(root.recoveryToken);
      const globalRateHash = await hashRateLimitKey(
        config.rateLimitSecret,
        "global:recovery"
      );
      const globalRate = await repository.consumeRateLimit(globalRateHash, 100, 60);
      if (!globalRate.allowed) throw new RequestError(429, globalRate.retry_after_seconds);
      const rateHash = await hashRateLimitKey(config.rateLimitSecret, `recovery:${recoveryHash}`);
      const rate = await repository.consumeRateLimit(rateHash, 5, 300);
      if (!rate.allowed) throw new RequestError(429, rate.retry_after_seconds);

      if (!repository.recoverAttempt) throw new Error("Recovery operation is unavailable");
      const attemptResult = await repository.recoverAttempt({
        p_recovery_hash: recoveryHash,
        p_hold_expires_at: new Date(Date.now() + CHECKOUT_LIFETIME_MS).toISOString()
      });
      const attempt = await repository.getAttempt(attemptResult.attempt_id);
      if (
        attempt.id !== attemptResult.attempt_id ||
        attempt.order_id !== attemptResult.order_id ||
        typeof attempt.attempt_key !== "string" ||
        attempt.currency !== "GBP" ||
        safeInteger(attempt.amount_total) !== safeInteger(attemptResult.amount_total)
      ) {
        throw new Error("Recovered checkout attempt data mismatch");
      }
      const handoffToken = await registerGuestCapabilities(
        config,
        repository,
        attempt.order_id,
        attempt.id
      );
      const url = await createStripeSession(
        config,
        repository,
        stripe,
        attempt,
        attempt.attempt_key,
        handoffToken
      );
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ url }), { status: 200, headers });
    } catch (error) {
      const databaseCode = error !== null && typeof error === "object" && "code" in error
        ? /** @type {{ code?: string }} */ (error).code
        : undefined;
      const status = error instanceof RequestError
        ? error.status
        : error instanceof Error && error.message === "Invalid checkout request" ||
            databaseCode === "55000" || databaseCode === "42501"
          ? 409
          : 503;
      if (status === 503) console.error("Stripe checkout recovery operation failed");
      const headers = new Headers({
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Expose-Headers": "Retry-After",
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "Vary": "Origin"
      });
      if (config && origin && config.allowedOrigins.includes(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
      }
      if (status === 429 && error instanceof RequestError) {
        headers.set("Retry-After", String(Math.max(1, error.retryAfter)));
      }
      return new Response(JSON.stringify({
        error: status === 429
          ? "Too many recovery attempts. Please wait and try again."
          : status === 400 || status === 415
            ? "Invalid recovery request."
            : status === 409
              ? "This checkout cannot be safely resumed. Please contact support before paying again."
              : "Checkout recovery is temporarily unavailable."
      }), { status, headers });
    }
  };
}
