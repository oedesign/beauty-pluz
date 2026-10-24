const TIMESTAMP_HEADER = "x-beauty-pluz-gateway-timestamp";
const NONCE_HEADER = "x-beauty-pluz-gateway-nonce";
const SIGNATURE_HEADER = "x-beauty-pluz-gateway-signature";
const MAX_CHECKOUT_BODY_BYTES = 16 * 1024;
const MAX_GUEST_BODY_BYTES = 8 * 1024;

const ROUTES = new Map([
  ["stripe-checkout", { limit: 20, refillMs: 4000 }],
  ["stripe-guest-handoff", { limit: 10, refillMs: 6000 }],
  ["stripe-guest-status", { limit: 60, refillMs: 1000 }],
  ["stripe-checkout-recover", { limit: 5, refillMs: 12000 }]
]);

function jsonResponse(status, body, origin = null, retryAfter = null) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin"
  });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  if (retryAfter !== null) headers.set("Retry-After", String(retryAfter));
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function parseAllowedOrigins(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Gateway configuration unavailable");
  const origins = value.split(",").map((entry) => {
    const candidate = entry.trim();
    const url = new URL(candidate);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.origin !== candidate ||
      url.username ||
      url.password
    ) {
      throw new Error("Gateway configuration unavailable");
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error("Gateway configuration unavailable");
  return origins;
}

function isPublishableKey(value) {
  if (value.startsWith("sb_publishable_")) return value.length > "sb_publishable_".length;
  const payload = value.split(".")[1];
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return false;
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(payload.length / 4) * 4,
      "="
    );
    return JSON.parse(atob(padded)).role === "anon";
  } catch {
    return false;
  }
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Gateway configuration unavailable");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "="
  );
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createGatewayAssertion(privateKeyValue, method, pathname, body) {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeBase64Url(privateKeyValue),
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = encodeBase64Url(nonceBytes);
  const bodyDigest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  ));
  const canonical = [
    "beauty-pluz-gateway-v1",
    method,
    pathname,
    timestamp,
    nonce,
    encodeHex(bodyDigest)
  ].join("\n");
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(canonical)
  );
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: encodeBase64Url(new Uint8Array(signature))
  };
}

function parseEnvironment(env) {
  const origins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const gatewayPrivateKey = typeof env.GUEST_GATEWAY_PRIVATE_KEY === "string"
    ? env.GUEST_GATEWAY_PRIVATE_KEY.trim()
    : "";
  let gatewayPrivateKeyBytes;
  try {
    gatewayPrivateKeyBytes = decodeBase64Url(gatewayPrivateKey);
  } catch {
    throw new Error("Gateway configuration unavailable");
  }
  if (gatewayPrivateKeyBytes.length < 32 || gatewayPrivateKeyBytes.length > 128) {
    throw new Error("Gateway configuration unavailable");
  }
  const rateLimitSecret = typeof env.GUEST_RATE_LIMIT_SECRET === "string"
    ? env.GUEST_RATE_LIMIT_SECRET.trim()
    : "";
  if (rateLimitSecret.length < 32) throw new Error("Gateway configuration unavailable");

  const supabaseUrl = new URL(typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL : "");
  const local = supabaseUrl.hostname === "localhost" || supabaseUrl.hostname === "127.0.0.1";
  if (
    (supabaseUrl.protocol !== "https:" && !(local && supabaseUrl.protocol === "http:")) ||
    supabaseUrl.username ||
    supabaseUrl.password ||
    supabaseUrl.search ||
    supabaseUrl.hash ||
    (supabaseUrl.pathname !== "" && supabaseUrl.pathname !== "/")
  ) {
    throw new Error("Gateway configuration unavailable");
  }

  const publishableKey = typeof env.SUPABASE_PUBLISHABLE_KEY === "string"
    ? env.SUPABASE_PUBLISHABLE_KEY.trim()
    : "";
  if (!publishableKey || !isPublishableKey(publishableKey)) {
    throw new Error("Gateway configuration unavailable");
  }
  if (!env.GUEST_RATE_LIMITER || typeof env.GUEST_RATE_LIMITER.get !== "function") {
    throw new Error("Gateway configuration unavailable");
  }
  return {
    origins,
    gatewayPrivateKey,
    rateLimitSecret,
    supabaseOrigin: supabaseUrl.origin,
    publishableKey,
    limiter: env.GUEST_RATE_LIMITER
  };
}

async function readBoundedJson(request, limit) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && !/^\d+$/.test(contentLength)) {
    return { errorStatus: 400 };
  }
  if (contentLength !== null && Number(contentLength) > limit) {
    return { errorStatus: 413 };
  }
  if (!request.body) return { errorStatus: 400 };

  try {
    const reader = request.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        return { errorStatus: 413 };
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { errorStatus: 400 };
    }
    return { text, value };
  } catch {
    return { errorStatus: 400 };
  }
}

function validPayload(endpoint, value) {
  const keys = Object.keys(value);
  if (endpoint === "stripe-checkout") {
    return keys.every((key) => ["idempotencyKey", "customer", "items"].includes(key)) &&
      typeof value.idempotencyKey === "string" &&
      value.customer !== null &&
      typeof value.customer === "object" &&
      !Array.isArray(value.customer) &&
      Array.isArray(value.items);
  }
  const capabilityKey = endpoint === "stripe-guest-handoff"
    ? "handoffToken"
    : endpoint === "stripe-guest-status"
      ? "statusToken"
      : "recoveryToken";
  return keys.length === 1 &&
    keys[0] === capabilityKey &&
    typeof value[capabilityKey] === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value[capabilityKey]);
}

function normalizeClientIp(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const ipv4Parts = value.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d{1,3}$/.test(part))) {
    const octets = ipv4Parts.map(Number);
    if (octets.every((octet) => octet >= 0 && octet <= 255)) {
      return `v4:${octets.join(".")}`;
    }
    return null;
  }
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return null;

  let address = value.toLowerCase();
  const embeddedV4 = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedV4) {
    const octets = embeddedV4[1].split(".").map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    const mapped = `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    address = `${address.slice(0, address.length - embeddedV4[1].length)}${mapped}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...right
  ].map((part) => part.padStart(4, "0"));
  if (groups.length !== 8) return null;
  if (
    groups.slice(0, 5).every((part) => part === "0000") &&
    groups[5] === "ffff"
  ) {
    const octets = [
      Number.parseInt(groups[6].slice(0, 2), 16),
      Number.parseInt(groups[6].slice(2), 16),
      Number.parseInt(groups[7].slice(0, 2), 16),
      Number.parseInt(groups[7].slice(2), 16)
    ];
    return `v4:${octets.join(".")}`;
  }
  return `v6:${groups.slice(0, 4).join(":")}/64`;
}

async function hashIdentity(secret, endpoint, clientIp) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`beauty-pluz:gateway:${endpoint}:${clientIp}`)
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit(limiter, secret, endpoint, clientIp, nowMs = Date.now()) {
  const bucketKey = await hashIdentity(secret, endpoint, clientIp);
  const shardId = limiter.idFromName(bucketKey.slice(0, 2));
  const shard = limiter.get(shardId);
  const response = await shard.fetch("https://guest-rate-limiter/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucketKey,
      endpoint,
      nowMs
    })
  });
  if (!response.ok) throw new Error("Gateway limiter unavailable");
  const result = await response.json();
  if (
    !result ||
    typeof result.allowed !== "boolean" ||
    (result.allowed === false &&
      (!Number.isInteger(result.retryAfter) || result.retryAfter < 1))
  ) {
    throw new Error("Gateway limiter unavailable");
  }
  return result;
}

export class GuestRateLimiter {
  constructor(state) {
    this.storage = state.storage;
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS guest_rate_buckets (
        bucket_key TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/consume") {
      return new Response(null, { status: 404 });
    }
    let input;
    try {
      input = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    if (
      !input ||
      !/^[a-f0-9]{64}$/.test(input.bucketKey) ||
      !ROUTES.has(input.endpoint) ||
      !Number.isSafeInteger(input.nowMs) ||
      input.nowMs < 0
    ) {
      return new Response(null, { status: 400 });
    }

    const policy = ROUTES.get(input.endpoint);
    const rows = this.storage.sql.exec(
      "SELECT tokens, updated_at_ms FROM guest_rate_buckets WHERE bucket_key = ?",
      input.bucketKey
    ).toArray();
    // Keep the read/decision/write path synchronous so requests cannot interleave.
    const previous = rows[0];
    const lastTime = previous ? Math.max(previous.updated_at_ms, input.nowMs) : input.nowMs;
    const elapsed = previous ? Math.max(0, input.nowMs - previous.updated_at_ms) : 0;
    const available = previous
      ? Math.min(policy.limit, previous.tokens + elapsed / policy.refillMs)
      : policy.limit;
    const allowed = available >= 1;
    const tokens = allowed ? available - 1 : available;
    const retryAfter = allowed
      ? null
      : Math.max(1, Math.ceil((1 - tokens) * policy.refillMs / 1000));

    this.storage.sql.exec(
      `INSERT INTO guest_rate_buckets (bucket_key, tokens, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         tokens = excluded.tokens,
         updated_at_ms = excluded.updated_at_ms`,
      input.bucketKey,
      tokens,
      lastTime
    );
    this.storage.sql.exec(
      "DELETE FROM guest_rate_buckets WHERE updated_at_ms < ?",
      input.nowMs - 24 * 60 * 60 * 1000
    );
    return Response.json({ allowed, retryAfter });
  }
}

export function createGatewayHandler(fetchImpl = globalThis.fetch) {
  return async (request, env) => {
    const requestUrl = new URL(request.url);
    const endpoint = requestUrl.pathname.slice(1);
    if (!ROUTES.has(endpoint) || requestUrl.search || requestUrl.hash) {
      return jsonResponse(404, { error: "Checkout endpoint not found." });
    }

    let config;
    try {
      config = parseEnvironment(env);
    } catch {
      return jsonResponse(503, { error: "Checkout is temporarily unavailable." });
    }

    const origin = request.headers.get("origin");
    if (!origin || !config.origins.includes(origin)) {
      return jsonResponse(403, { error: "Request origin is not allowed." });
    }
    if (request.method === "OPTIONS") {
      const requestedMethod = request.headers.get("access-control-request-method");
      const requestedHeaders = request.headers.get("access-control-request-headers") ?? "";
      if (
        requestedMethod !== "POST" ||
        requestedHeaders.split(",").some((header) => header.trim().toLowerCase() !== "content-type")
      ) {
        return jsonResponse(403, { error: "Request is not allowed." }, origin);
      }
      return jsonResponse(204, null, origin);
    }
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed." }, origin);
    }
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return jsonResponse(415, { error: "Invalid checkout request." }, origin);
    }

    const limit = endpoint === "stripe-checkout" ? MAX_CHECKOUT_BODY_BYTES : MAX_GUEST_BODY_BYTES;
    let parsedBody;
    try {
      parsedBody = await readBoundedJson(request, limit);
    } catch {
      return jsonResponse(400, { error: "Invalid checkout request." }, origin);
    }
    if (parsedBody.errorStatus) {
      return jsonResponse(parsedBody.errorStatus, { error: "Invalid checkout request." }, origin);
    }
    if (!validPayload(endpoint, parsedBody.value)) {
      return jsonResponse(400, { error: "Invalid checkout request." }, origin);
    }

    // Cloudflare replaces this header on public ingress; never fall back to forwarded headers.
    const ingressIp = request.headers.get("cf-connecting-ip");
    const clientIp = ingressIp ? normalizeClientIp(ingressIp) : null;
    if (!clientIp) {
      return jsonResponse(503, { error: "Checkout is temporarily unavailable." }, origin);
    }

    try {
      const rate = await checkRateLimit(
        config.limiter,
        config.rateLimitSecret,
        endpoint,
        clientIp
      );
      if (!rate.allowed) {
        return jsonResponse(
          429,
          { error: "Too many requests. Please wait and try again." },
          origin,
          rate.retryAfter
        );
      }
    } catch {
      return jsonResponse(503, { error: "Checkout is temporarily unavailable." }, origin);
    }

    const upstreamUrl = `${config.supabaseOrigin}/functions/v1/${endpoint}`;
    let assertionHeaders;
    try {
      assertionHeaders = await createGatewayAssertion(
        config.gatewayPrivateKey,
        "POST",
        new URL(upstreamUrl).pathname,
        parsedBody.text
      );
    } catch {
      return jsonResponse(503, { error: "Checkout is temporarily unavailable." }, origin);
    }
    const upstreamHeaders = new Headers({
      "Content-Type": "application/json",
      "Origin": origin,
      "apikey": config.publishableKey,
      ...assertionHeaders
    });
    let upstream;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: parsedBody.text,
        redirect: "manual"
      });
    } catch {
      return jsonResponse(503, { error: "Checkout is temporarily unavailable." }, origin);
    }

    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Expose-Headers": "Retry-After",
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin"
    });
    const retryAfter = upstream.headers.get("Retry-After");
    if (upstream.status === 429) {
      responseHeaders.set(
        "Retry-After",
        retryAfter && /^\d{1,6}$/.test(retryAfter) ? retryAfter : "60"
      );
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });
  };
}

export default {
  fetch: createGatewayHandler()
};
