// @ts-check
import { gatewayAuthFailure, verifyGatewayRequest } from "./gateway-auth.mjs";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function deriveGuestCapability(secret, purpose, subjectId) {
  if (secret.length < 32 || !/^[0-9a-f-]{36}$/i.test(subjectId)) {
    throw new Error("Invalid guest capability input");
  }
  return encodeBase64Url(await hmac(secret, `beautypluz:guest:${purpose}:${subjectId}`));
}

export async function hashGuestCapability(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error("Invalid guest capability");
  }
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashRateLimitKey(secret, value) {
  const bytes = await hmac(secret, `beautypluz:rate:${value}`);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function appendHandoffFragment(value, handoffToken) {
  const url = new URL(value);
  url.hash = `handoff=${encodeURIComponent(handoffToken)}`;
  return url.href;
}

export function readGuestConfig(getEnv) {
  const required = (name) => {
    const value = getEnv(name)?.trim();
    if (!value) throw new Error("Missing guest checkout configuration");
    return value;
  };
  const capabilitySecret = required("CHECKOUT_CAPABILITY_SECRET");
  const rateLimitSecret = required("CHECKOUT_RATE_LIMIT_SECRET");
  if (capabilitySecret.length < 32 || rateLimitSecret.length < 32) {
    throw new Error("Guest checkout secrets are too short");
  }

  const allowedOrigins = required("CHECKOUT_ALLOWED_ORIGINS").split(",").map((entry) => {
    const origin = entry.trim();
    const url = new URL(origin);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (
      (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) ||
      url.origin !== origin ||
      url.username ||
      url.password
    ) {
      throw new Error("Invalid guest checkout origin");
    }
    return url.origin;
  });
  if (allowedOrigins.length === 0 || new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new Error("Invalid guest checkout origins");
  }

  const supabaseUrl = required("SUPABASE_URL");
  if (!/^https?:\/\//.test(supabaseUrl)) throw new Error("Invalid Supabase URL");
  return {
    allowedOrigins,
    capabilitySecret,
    rateLimitSecret,
    supabaseUrl,
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY")
  };
}

export async function consumeCheckoutRateLimits(repository, config, email, idempotencyKey) {
  const buckets = [
    [await hashRateLimitKey(config.rateLimitSecret, `checkout-email:${email}`), 5, 300],
    [await hashRateLimitKey(config.rateLimitSecret, `checkout-key:${idempotencyKey}`), 10, 600],
    [await hashRateLimitKey(config.rateLimitSecret, "checkout-global"), 100, 60]
  ];
  let retryAfter = 0;
  for (const [bucketHash, limit, windowSeconds] of buckets) {
    const result = await repository.consumeRateLimit(bucketHash, limit, windowSeconds);
    if (!result.allowed) retryAfter = Math.max(retryAfter, result.retry_after_seconds);
  }
  return { allowed: retryAfter === 0, retryAfter };
}

function responseHeaders(origin, allowedOrigins) {
  if (origin && !allowedOrigins.includes(origin)) return null;
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Expose-Headers": "Retry-After",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Vary": "Origin"
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

async function readJson(request) {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const text = await request.text();
  if (text.length > 8192) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function statusMessage(status) {
  if (status === "paid") return "Payment confirmed by our server.";
  if (status === "failed") return "Payment was not confirmed. You may review recovery options.";
  return "Payment is still being confirmed. This page does not treat the Stripe redirect as proof of payment.";
}

/**
 * @param {{
 *   getEnv: (name: string) => string | undefined,
 *   createServices: (config: ReturnType<typeof readGuestConfig>) => Promise<{
 *     exchangeHandoff: (hash: string) => Promise<{
 *       order_id: string,
 *       order_reference: string,
 *       payment_status: string
 *     } | null>,
 *     getStatus: (hash: string) => Promise<{
 *       order_reference: string,
 *       payment_status: string
 *     } | null>,
 *     consumeRateLimit: (hash: string, limit: number, windowSeconds: number) => Promise<{
 *       allowed: boolean,
 *       retry_after_seconds: number
 *     }>
 *   }>
 * }} dependencies
 */
export function createGuestHandoffHandler(dependencies) {
  return createGuestTokenHandler(dependencies, "handoff");
}

/**
 * @param {{
 *   getEnv: (name: string) => string | undefined,
 *   createServices: (config: ReturnType<typeof readGuestConfig>) => Promise<{
 *     getStatus: (hash: string) => Promise<{
 *       order_reference: string,
 *       payment_status: string
 *     } | null>,
 *     consumeRateLimit: (hash: string, limit: number, windowSeconds: number) => Promise<{
 *       allowed: boolean,
 *       retry_after_seconds: number
 *     }>
 *   }>
 * }} dependencies
 */
export function createGuestStatusHandler(dependencies) {
  return createGuestTokenHandler(dependencies, "status");
}

function createGuestTokenHandler(dependencies, action) {
  return async (request) => {
    let config;
    let origin = request.headers.get("origin");
    try {
      const gatewayAuth = await verifyGatewayRequest(request, dependencies.getEnv, {
        consumeNonce: dependencies.consumeGatewayNonce
      });
      if (gatewayAuth !== "authorized") return gatewayAuthFailure(gatewayAuth);
      config = readGuestConfig(dependencies.getEnv);
      const headers = responseHeaders(origin, config.allowedOrigins);
      if (!headers) return new Response(null, { status: 403 });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
      }
      const body = await readJson(request);
      const tokenKey = action === "handoff" ? "handoffToken" : "statusToken";
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        typeof body[tokenKey] !== "string" ||
        !TOKEN_PATTERN.test(body[tokenKey])
      ) {
        return new Response(JSON.stringify({ error: "Order status is unavailable." }), { status: 400, headers });
      }

      const services = await dependencies.createServices(config);
      const hash = await hashGuestCapability(body[tokenKey]);
      const globalRateKey = await hashRateLimitKey(
        config.rateLimitSecret,
        `global:${action}`
      );
      const globalRate = await services.consumeRateLimit(globalRateKey, 100, 60);
      if (!globalRate.allowed) {
        headers.set("Retry-After", String(globalRate.retry_after_seconds));
        return new Response(JSON.stringify({ error: "Please wait before checking this order again." }), {
          status: 429,
          headers
        });
      }
      const rateKey = await hashRateLimitKey(config.rateLimitSecret, `${action}:${hash}`);
      const rate = await services.consumeRateLimit(rateKey, action === "handoff" ? 10 : 30, 300);
      if (!rate.allowed) {
        headers.set("Retry-After", String(rate.retry_after_seconds));
        return new Response(JSON.stringify({ error: "Please wait before checking this order again." }), {
          status: 429,
          headers
        });
      }
      const handoff = action === "handoff" ? await services.exchangeHandoff(hash) : null;
      const status = action === "handoff" ? handoff : await services.getStatus(hash);
      if (!status) {
        return new Response(JSON.stringify({ error: "Order status is unavailable." }), { status: 404, headers });
      }

      const payload = {
        orderReference: status.order_reference,
        paymentStatus: status.payment_status,
        message: statusMessage(status.payment_status)
      };
      if (action === "handoff" && handoff) {
        payload.statusToken = await deriveGuestCapability(
          config.capabilitySecret,
          "status",
          handoff.order_id
        );
        payload.recoveryToken = await deriveGuestCapability(
          config.capabilitySecret,
          "recovery",
          handoff.order_id
        );
      }
      return new Response(JSON.stringify(payload), { status: 200, headers });
    } catch {
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
      return new Response(JSON.stringify({ error: "Order status is temporarily unavailable." }), {
        status: 503,
        headers
      });
    }
  };
}
