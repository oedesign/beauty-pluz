import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createGuestStatusHandler } from "../../backend/supabase/functions/_shared/guest-access.mjs";
import { gatewayAssertionHeaders, gatewayTestKeys } from "../../backend/supabase/tests/gateway_assertions.test-helper.mjs";
import { createGatewayHandler, GuestRateLimiter } from "../src/index.mjs";

globalThis.crypto ??= webcrypto;

const origin = "https://store.example.test";
const publishableKey = "sb_publishable_test";
const validBodies = {
  "stripe-checkout": {
    idempotencyKey: "checkout-attempt-0001",
    customer: {
      name: "Test Customer",
      email: "customer@example.invalid",
      phone: null,
      shippingAddress: "1 Test Street, London"
    },
    items: [{ productId: "test-product", quantity: 1 }]
  },
  "stripe-guest-handoff": { handoffToken: "H".repeat(43) },
  "stripe-guest-status": { statusToken: "S".repeat(43) },
  "stripe-checkout-recover": { recoveryToken: "R".repeat(43) }
};

class MemorySql {
  constructor() {
    this.rows = new Map();
  }

  exec(query, ...parameters) {
    if (query.includes("CREATE TABLE")) return { toArray: () => [] };
    if (query.includes("SELECT tokens")) {
      const row = this.rows.get(parameters[0]);
      return { toArray: () => row ? [{ ...row }] : [] };
    }
    if (query.includes("INSERT INTO guest_rate_buckets")) {
      this.rows.set(parameters[0], {
        tokens: parameters[1],
        updated_at_ms: parameters[2]
      });
      return { toArray: () => [] };
    }
    if (query.includes("DELETE FROM guest_rate_buckets")) {
      for (const [key, row] of this.rows) {
        if (row.updated_at_ms < parameters[0]) this.rows.delete(key);
      }
      return { toArray: () => [] };
    }
    throw new Error("Unexpected Durable Object SQL query");
  }
}

function createLimiterBinding(options = {}) {
  const objects = new Map();
  const requests = [];
  return {
    requests,
    idFromName(name) { return name; },
    get(id) {
      return {
        async fetch(url, init) {
          const input = JSON.parse(init.body);
          requests.push({ id, input });
          if (options.fail) throw new Error("limiter unavailable");
          if (options.decide) return Response.json(options.decide(input));
          let object = objects.get(id);
          if (!object) {
            object = new GuestRateLimiter({ storage: { sql: new MemorySql() } });
            objects.set(id, object);
          }
          return object.fetch(new Request(url, init));
        }
      };
    }
  };
}

function gatewayEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: origin,
    GUEST_GATEWAY_PRIVATE_KEY: gatewayTestKeys.privateKey,
    GUEST_RATE_LIMIT_SECRET: "local-rate-limit-secret-with-at-least-32-bytes",
    SUPABASE_URL: "https://project-ref.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    GUEST_RATE_LIMITER: createLimiterBinding(),
    ...overrides
  };
}

function gatewayRequest(endpoint, options = {}) {
  const headers = new Headers({
    Origin: options.origin ?? origin,
    "Content-Type": options.contentType ?? "application/json",
    "CF-Connecting-IP": options.clientIp ?? "198.51.100.7",
    "X-Forwarded-For": options.forwardedFor ?? "203.0.113.10",
    "X-Beauty-Pluz-Gateway-Auth": options.clientGatewaySecret ?? "attacker-value"
  });
  if (options.contentLength) headers.set("Content-Length", options.contentLength);
  const method = options.method ?? "POST";
  if (options.withClientIp === false) headers.delete("CF-Connecting-IP");
  if (options.withForwardedFor === false) headers.delete("X-Forwarded-For");
  return new Request(`https://gateway.example.test/${endpoint}${options.query ?? ""}`, {
    method,
    headers,
    body: method === "POST" ? options.rawBody ?? JSON.stringify(options.body ?? validBodies[endpoint]) : undefined
  });
}

test("only the four configured guest endpoints are proxied", async () => {
  const proxied = [];
  const handler = createGatewayHandler(async (url) => {
    proxied.push(new URL(url).pathname);
    return Response.json({ ok: true });
  });
  const endpoints = Object.keys(validBodies);
  for (const endpoint of endpoints) {
    const response = await handler(gatewayRequest(endpoint), gatewayEnv());
    assert.equal(response.status, 200);
  }
  for (const path of [
    "stripe-webhook",
    "stripe-guest-handoff/extra",
    "other-function"
  ]) {
    const response = await handler(gatewayRequest(path), gatewayEnv());
    assert.equal(response.status, 404);
  }
  assert.deepEqual(proxied, endpoints.map((endpoint) => `/functions/v1/${endpoint}`));
});

test("gateway validates methods, JSON shape, origin, and bounded payload size", async () => {
  let upstreamCalls = 0;
  const handler = createGatewayHandler(async () => {
    upstreamCalls += 1;
    return Response.json({ ok: true });
  });
  const checks = [
    [gatewayRequest("stripe-checkout", { method: "GET" }), 405],
    [gatewayRequest("stripe-checkout", { contentType: "text/plain" }), 415],
    [gatewayRequest("stripe-checkout", { rawBody: "not-json" }), 400],
    [gatewayRequest("stripe-checkout", {
      body: { ...validBodies["stripe-checkout"], price: 0.01 }
    }), 400],
    [gatewayRequest("stripe-guest-status", { body: { statusToken: "short" } }), 400],
    [gatewayRequest("stripe-checkout", {
      body: {
        ...validBodies["stripe-checkout"],
        customer: { ...validBodies["stripe-checkout"].customer, shippingAddress: "x".repeat(17000) }
      }
    }), 413],
    [gatewayRequest("stripe-checkout", { origin: "https://attacker.example.test" }), 403],
    [gatewayRequest("stripe-checkout", { query: "?unexpected=1" }), 404]
  ];
  for (const [request, status] of checks) {
    assert.equal((await handler(request, gatewayEnv())).status, status);
  }
  assert.equal(upstreamCalls, 0);
});

test("preflight is limited to the configured origin and content-type header", async () => {
  const handler = createGatewayHandler();
  const good = new Request("https://gateway.example.test/stripe-checkout", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type"
    }
  });
  assert.equal((await handler(good, gatewayEnv())).status, 204);

  const bad = new Request("https://gateway.example.test/stripe-checkout", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type"
    }
  });
  assert.equal((await handler(bad, gatewayEnv())).status, 403);
});

test("gateway accepts legacy anon JWT keys but rejects service-role JWT keys", async () => {
  const handler = createGatewayHandler(async () => Response.json({ ok: true }));
  const token = (role) => {
    const payload = btoa(JSON.stringify({ role }))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    return `header.${payload}.signature`;
  };
  const anonResponse = await handler(gatewayRequest("stripe-checkout"), gatewayEnv({
    SUPABASE_PUBLISHABLE_KEY: token("anon")
  }));
  const serviceResponse = await handler(gatewayRequest("stripe-checkout"), gatewayEnv({
    SUPABASE_PUBLISHABLE_KEY: token("service_role")
  }));
  assert.equal(anonResponse.status, 200);
  assert.equal(serviceResponse.status, 503);
});

test("Worker replaces client auth headers and forwards only required credentials", async () => {
  let forwarded;
  const handler = createGatewayHandler(async (url, init) => {
    forwarded = { url, headers: new Headers(init.headers), body: init.body };
    return Response.json({ ok: true });
  });
  const response = await handler(gatewayRequest("stripe-checkout", {
    clientGatewaySecret: "caller-controlled-value"
  }), gatewayEnv());
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get("x-beauty-pluz-gateway-auth"), null);
  assert.match(forwarded.headers.get("x-beauty-pluz-gateway-timestamp"), /^\d{10}$/);
  assert.match(forwarded.headers.get("x-beauty-pluz-gateway-nonce"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(forwarded.headers.get("x-beauty-pluz-gateway-signature"), /^[A-Za-z0-9_-]{86}$/);
  assert.equal(forwarded.headers.get("x-forwarded-for"), null);
  assert.equal(forwarded.headers.get("cf-connecting-ip"), null);
  assert.equal(forwarded.headers.get("cookie"), null);
  assert.equal(forwarded.headers.get("authorization"), null);
  assert.equal(forwarded.headers.get("apikey"), publishableKey);
  assert.equal(forwarded.headers.get("origin"), origin);
  assert.equal(forwarded.url, "https://project-ref.supabase.co/functions/v1/stripe-checkout");
  assert.equal(forwarded.body, JSON.stringify(validBodies["stripe-checkout"]));
});

test("legitimate Worker request passes Edge auth; direct-origin requests are rejected", async () => {
  const edgeCalls = [];
  const consumedNonces = new Set();
  const edgeHandler = createGuestStatusHandler({
    getEnv(name) {
      return {
        GUEST_GATEWAY_PUBLIC_KEY: gatewayTestKeys.publicKey,
        CHECKOUT_CAPABILITY_SECRET: "test-capability-secret-with-at-least-32-bytes",
        CHECKOUT_RATE_LIMIT_SECRET: "test-rate-limit-secret-with-at-least-32-bytes",
        CHECKOUT_ALLOWED_ORIGINS: origin,
        SUPABASE_URL: "https://project-ref.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"
      }[name];
    },
    async consumeGatewayNonce(hash) {
      if (consumedNonces.has(hash)) return false;
      consumedNonces.add(hash);
      return true;
    },
    async createServices() {
      edgeCalls.push("services");
      return {
        async getStatus() {
          return { order_reference: "abc12345", payment_status: "pending" };
        },
        async consumeRateLimit() {
          return { allowed: true, retry_after_seconds: 0 };
        }
      };
    }
  });
  const worker = createGatewayHandler((url, init) => {
    const runtimeUrl = new URL(url);
    runtimeUrl.pathname = runtimeUrl.pathname.replace(/^\/functions\/v1/, "");
    return edgeHandler(new Request(runtimeUrl, init));
  });
  const proxied = await worker(gatewayRequest("stripe-guest-status"), gatewayEnv());
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), {
    orderReference: "abc12345",
    paymentStatus: "pending",
    message: "Payment is still being confirmed. This page does not treat the Stripe redirect as proof of payment."
  });

  const directWithoutSecret = await edgeHandler(new Request(
    "https://project-ref.supabase.co/functions/v1/stripe-guest-status",
    {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(validBodies["stripe-guest-status"])
    }
  ));
  const directWithWrongSecret = await edgeHandler(new Request(
    "https://project-ref.supabase.co/functions/v1/stripe-guest-status",
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-beauty-pluz-gateway-auth": "wrong-secret"
      },
      body: JSON.stringify(validBodies["stripe-guest-status"])
    }
  ));
  assert.equal(directWithoutSecret.status, 401);
  assert.equal(directWithWrongSecret.status, 401);
  assert.equal(edgeCalls.length, 1);
  assert.doesNotMatch(await directWithoutSecret.text(), /private|signature/i);
});

test("Edge assertions bind method, path, timestamp, body, and single-use nonce", async () => {
  const consumedNonces = new Set();
  const edgeHandler = createGuestStatusHandler({
    getEnv(name) {
      return {
        GUEST_GATEWAY_PUBLIC_KEY: gatewayTestKeys.publicKey,
        CHECKOUT_CAPABILITY_SECRET: "test-capability-secret-with-at-least-32-bytes",
        CHECKOUT_RATE_LIMIT_SECRET: "test-rate-limit-secret-with-at-least-32-bytes",
        CHECKOUT_ALLOWED_ORIGINS: origin,
        SUPABASE_URL: "https://project-ref.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key"
      }[name];
    },
    async consumeGatewayNonce(hash) {
      if (consumedNonces.has(hash)) return false;
      consumedNonces.add(hash);
      return true;
    },
    async createServices() {
      return {
        async getStatus() {
          return { order_reference: "abc12345", payment_status: "pending" };
        },
        async consumeRateLimit() {
          return { allowed: true, retry_after_seconds: 0 };
        }
      };
    }
  });
  const url = "https://project-ref.supabase.co/functions/v1/stripe-guest-status";
  const body = JSON.stringify(validBodies["stripe-guest-status"]);
  const requestWith = async (headers, bodyValue = body, method = "POST", requestUrl = url) => {
    const runtimeUrl = new URL(requestUrl);
    runtimeUrl.pathname = runtimeUrl.pathname.replace(/^\/functions\/v1/, "");
    return edgeHandler(new Request(runtimeUrl, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...headers
      },
      body: method === "GET" ? undefined : bodyValue
    }));
  };
  const expiredHeaders = await gatewayAssertionHeaders(url, "POST", body, {
    timestamp: Math.floor(Date.now() / 1000) - 120
  });
  assert.equal((await requestWith(expiredHeaders)).status, 401, "expired assertion");

  const wrongPath = "https://project-ref.supabase.co/functions/v1/stripe-checkout";
  assert.equal((await requestWith(
    await gatewayAssertionHeaders(wrongPath, "POST", body)
  )).status, 401, "wrong-path assertion");

  const getHeaders = await gatewayAssertionHeaders(url, "GET", "");
  assert.equal((await requestWith(getHeaders, "", "GET")).status, 401, "wrong-method assertion");

  const originalBody = JSON.stringify(validBodies["stripe-guest-status"]);
  const modifiedBodyHeaders = await gatewayAssertionHeaders(url, "POST", originalBody);
  assert.equal((await requestWith(
    modifiedBodyHeaders,
    JSON.stringify({ statusToken: "T".repeat(43) })
  )).status, 401, "modified body");

  const replayHeaders = await gatewayAssertionHeaders(url, "POST", body);
  assert.equal((await requestWith(replayHeaders)).status, 200, "valid request-bound assertion");
  assert.equal((await requestWith(replayHeaders)).status, 401, "replayed assertion");

  const validHeaders = await gatewayAssertionHeaders(url, "POST", body);
  validHeaders["x-beauty-pluz-gateway-signature"] = "A".repeat(86);
  assert.equal((await requestWith(validHeaders)).status, 401, "invalid Ed25519 signature");
});

test("missing or invalid gateway credentials fail closed without exposing secrets", async () => {
  let upstreamCalls = 0;
  const handler = createGatewayHandler(async () => {
    upstreamCalls += 1;
    return Response.json({ ok: true });
  });
  const missingSecret = await handler(gatewayRequest("stripe-checkout"), gatewayEnv({
    GUEST_GATEWAY_PRIVATE_KEY: ""
  }));
  const noLimiter = await handler(gatewayRequest("stripe-checkout"), gatewayEnv({
    GUEST_RATE_LIMITER: undefined
  }));
  assert.equal(missingSecret.status, 503);
  assert.equal(noLimiter.status, 503);
  assert.equal(upstreamCalls, 0);
  const rejectedPrivateKey = await handler(gatewayRequest("stripe-checkout"), gatewayEnv({
    SUPABASE_PUBLISHABLE_KEY: "sb_secret_not-a-publishable-key"
  }));
  assert.equal(rejectedPrivateKey.status, 503);
  assert.equal(upstreamCalls, 0);
  for (const response of [missingSecret, noLimiter]) {
    const text = await response.text();
    assert.doesNotMatch(text, /private-key|supabase|service-role/i);
    assert.equal(response.headers.get("x-beauty-pluz-gateway-signature"), null);
  }

  const guestHandler = createGuestStatusHandler({
    getEnv: (name) => ({
      CHECKOUT_ALLOWED_ORIGINS: origin,
      CHECKOUT_CAPABILITY_SECRET: "test-capability-secret-with-at-least-32-bytes",
      CHECKOUT_RATE_LIMIT_SECRET: "test-rate-limit-secret-with-at-least-32-bytes"
    }[name]),
    async createServices() {
      throw new Error("Must not create backend services");
    }
  });
  const unavailable = await guestHandler(new Request(
    "https://project-ref.supabase.co/functions/v1/stripe-guest-status",
    {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-beauty-pluz-gateway-auth": "old-static-credential"
      },
      body: JSON.stringify(validBodies["stripe-guest-status"])
    }
  ));
  assert.equal(unavailable.status, 503);
});

test("gateway limiter returns 429 with Retry-After and does not call Supabase", async () => {
  let upstreamCalls = 0;
  const handler = createGatewayHandler(async () => {
    upstreamCalls += 1;
    return Response.json({ ok: true });
  });
  const response = await handler(gatewayRequest("stripe-checkout"), gatewayEnv({
    GUEST_RATE_LIMITER: createLimiterBinding({
      decide: () => ({ allowed: false, retryAfter: 17 })
    })
  }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "17");
  assert.deepEqual(await response.json(), {
    error: "Too many requests. Please wait and try again."
  });
  assert.equal(upstreamCalls, 0);
});

test("limiter outage and missing trusted ingress IP fail closed without fallback headers", async () => {
  let upstreamCalls = 0;
  const handler = createGatewayHandler(async () => {
    upstreamCalls += 1;
    return Response.json({ ok: true });
  });
  const limiterFailure = await handler(gatewayRequest("stripe-checkout"), gatewayEnv({
    GUEST_RATE_LIMITER: createLimiterBinding({ fail: true })
  }));
  const missingIp = await handler(gatewayRequest("stripe-checkout", {
    withClientIp: false,
    forwardedFor: "198.51.100.9"
  }), gatewayEnv());
  assert.equal(limiterFailure.status, 503);
  assert.equal(missingIp.status, 503);
  assert.equal(upstreamCalls, 0);
});

test("shared ingress addresses share limits while X-Forwarded-For is ignored and retries remain safe", async () => {
  const binding = createLimiterBinding();
  const bodies = [];
  const handler = createGatewayHandler(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ url: "https://checkout.stripe.com/c/pay/test" });
  });
  const first = await handler(gatewayRequest("stripe-checkout", {
    forwardedFor: "203.0.113.1"
  }), gatewayEnv({ GUEST_RATE_LIMITER: binding }));
  const retry = await handler(gatewayRequest("stripe-checkout", {
    forwardedFor: "203.0.113.2"
  }), gatewayEnv({ GUEST_RATE_LIMITER: binding }));
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(binding.requests.length, 2);
  assert.equal(binding.requests[0].input.bucketKey, binding.requests[1].input.bucketKey);
  assert.equal(bodies[0].idempotencyKey, bodies[1].idempotencyKey);

  const otherIp = await handler(gatewayRequest("stripe-checkout", {
    clientIp: "198.51.100.8",
    forwardedFor: "203.0.113.2"
  }), gatewayEnv({ GUEST_RATE_LIMITER: binding }));
  assert.equal(otherIp.status, 200);
  assert.notEqual(binding.requests[1].input.bucketKey, binding.requests[2].input.bucketKey);
});

test("IPv6 temporary addresses in the same /64 share the trusted ingress bucket", async () => {
  const binding = createLimiterBinding();
  const handler = createGatewayHandler(async () => Response.json({ ok: true }));
  for (const clientIp of ["2001:db8:abcd:12::1", "2001:db8:abcd:12::beef"]) {
    const response = await handler(gatewayRequest("stripe-guest-status", {
      clientIp
    }), gatewayEnv({ GUEST_RATE_LIMITER: binding }));
    assert.equal(response.status, 200);
  }
  assert.equal(binding.requests[0].input.bucketKey, binding.requests[1].input.bucketKey);
});

test("Durable Object token bucket enforces burst limits, retry time, refill, and concurrent requests", async () => {
  const limiter = new GuestRateLimiter({ storage: { sql: new MemorySql() } });
  const key = "a".repeat(64);
  async function consume(endpoint, nowMs) {
    const response = await limiter.fetch(new Request("https://limiter/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucketKey: key, endpoint, nowMs })
    }));
    return response.json();
  }

  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await consume("stripe-checkout-recover", 10_000), {
      allowed: true,
      retryAfter: null
    });
  }
  assert.deepEqual(await consume("stripe-checkout-recover", 10_000), {
    allowed: false,
    retryAfter: 12
  });
  assert.deepEqual(await consume("stripe-checkout-recover", 22_000), {
    allowed: true,
    retryAfter: null
  });

  const freshLimiter = new GuestRateLimiter({ storage: { sql: new MemorySql() } });
  const requests = Array.from({ length: 7 }, () => freshLimiter.fetch(new Request("https://limiter/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucketKey: "b".repeat(64),
      endpoint: "stripe-checkout-recover",
      nowMs: 30_000
    })
  })));
  const results = await Promise.all(requests);
  const decisions = await Promise.all(results.map((result) => result.json()));
  assert.equal(decisions.filter((decision) => decision.allowed).length, 5);
  assert.equal(decisions.filter((decision) => !decision.allowed).length, 2);
});

test("gateway responses and implementation do not expose secrets or request capabilities", async () => {
  const sensitive = "S".repeat(43);
  const handler = createGatewayHandler(async () => {
    throw new Error("upstream failed");
  });
  const response = await handler(gatewayRequest("stripe-guest-status", {
    body: { statusToken: sensitive }
  }), gatewayEnv());
  const body = await response.text();
  assert.equal(response.status, 503);
  assert.doesNotMatch(body, new RegExp(sensitive));
  assert.doesNotMatch(body, /private-key|gateway assertion/i);

  const [workerSource, backendConfig, checkoutClient, returnClient] = await Promise.all([
    readFile(new URL("../src/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../js/backend-config.js", import.meta.url), "utf8"),
    readFile(new URL("../../js/stripe-checkout.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../js/checkout-return.mjs", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(workerSource, /console\.(?:log|info|warn|error)/);
  for (const clientSource of [backendConfig, checkoutClient, returnClient]) {
    assert.doesNotMatch(clientSource, /GUEST_GATEWAY_PRIVATE_KEY|GUEST_GATEWAY_PUBLIC_KEY|x-beauty-pluz-gateway-/);
  }
});
