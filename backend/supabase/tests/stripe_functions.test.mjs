import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckoutHandler,
  createCheckoutRecoveryHandler
} from "../functions/_shared/checkout.mjs";
import {
  createGuestHandoffHandler,
  createGuestStatusHandler,
  deriveGuestCapability,
  hashGuestCapability
} from "../functions/_shared/guest-access.mjs";
import { createWebhookHandler } from "../functions/_shared/webhook.mjs";
import {
  gatewayAssertionHeaders,
  gatewayTestKeys
} from "./gateway_assertions.test-helper.mjs";
import { canonicalGatewayPath } from "../functions/_shared/gateway-auth.mjs";

const checkoutEnvironment = {
  STRIPE_SECRET_KEY: "sk_test_unit",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-service-role-test-key",
  CHECKOUT_CAPABILITY_SECRET: "unit-test-capability-secret-32-bytes-minimum",
  CHECKOUT_RATE_LIMIT_SECRET: "unit-test-rate-limit-secret-32-bytes-minimum",
  GUEST_GATEWAY_PUBLIC_KEY: gatewayTestKeys.publicKey,
  CHECKOUT_SUCCESS_URL: "http://127.0.0.1:5500/cart.html?session_id={CHECKOUT_SESSION_ID}",
  CHECKOUT_CANCEL_URL: "http://127.0.0.1:5500/cart.html?checkout=cancelled",
  CHECKOUT_ALLOWED_ORIGINS: "http://127.0.0.1:5500",
  CHECKOUT_DELIVERY_FEE_PENCE: "400"
};

const validCheckoutBody = {
  idempotencyKey: "checkout-test-key-0001",
  customer: {
    name: "Test Customer",
    email: "customer@example.invalid",
    phone: "+441234567890",
    shippingAddress: "1 Test Street, London, SW1A 1AA"
  },
  items: [{ productId: "bp-test-product", quantity: 2 }]
};

function checkoutHarness(options = {}) {
  const calls = {
    attemptInputs: [],
    createSession: [],
    retrieveSession: [],
    attached: [],
    capabilities: [],
    rateLimit: []
  };
  let expiresAt = null;
  const attempt = {
    id: "2fa85f64-5717-4562-b3fc-2c963f66afa6",
    order_id: "2fa85f64-5717-4562-b3fc-2c963f66afa7",
    attempt_key: validCheckoutBody.idempotencyKey,
    stripe_checkout_session_id: null,
    status: "creating",
    amount_total: 2100,
    currency: "GBP",
    customer_email: validCheckoutBody.customer.email,
    get expires_at() {
      return expiresAt;
    }
  };
  const repository = {
    async createAttempt(input) {
      calls.attemptInputs.push(input);
      expiresAt ??= input.p_hold_expires_at;
      return {
        order_id: attempt.order_id,
        attempt_id: attempt.id,
        amount_total: attempt.amount_total,
        currency: attempt.currency,
        reused: calls.attemptInputs.length > 1
      };
    },
    async getAttempt() {
      return { ...attempt, expires_at: expiresAt };
    },
    async getOrderItems() {
      return [{ product_id: "bp-test-product", product_name: "Trusted product", quantity: 2, unit_price: "8.50" }];
    },
    async attachSession(attemptKey, sessionId, expiresAtInput) {
      calls.attached.push({ attemptKey, sessionId, expiresAtInput });
      attempt.stripe_checkout_session_id = sessionId;
      attempt.status = "created";
    },
    async registerCapabilities(input) {
      calls.capabilities.push(input);
    },
    async consumeRateLimit(hash, limit, windowSeconds) {
      calls.rateLimit.push({ hash, limit, windowSeconds });
      if (options.consumeRateLimit) return options.consumeRateLimit(hash, limit, windowSeconds);
      return { allowed: true, retry_after_seconds: 0 };
    }
  };
  const stripe = {
    async createSession(params, idempotencyKey) {
      calls.createSession.push({ params, idempotencyKey });
      if (options.createSession) return await options.createSession(params, idempotencyKey);
      return {
        id: "cs_test_checkout_1",
        url: "https://checkout.stripe.com/c/pay/cs_test_checkout_1",
        status: "open",
        expires_at: params.expires_at
      };
    },
    async retrieveSession(sessionId) {
      calls.retrieveSession.push(sessionId);
      if (options.retrieveSession) return await options.retrieveSession(sessionId);
      return {
        id: sessionId,
        url: "https://checkout.stripe.com/c/pay/cs_test_checkout_1",
        status: "open",
        expires_at: Math.floor(Date.parse(expiresAt) / 1000)
      };
    }
  };
  const handler = createCheckoutHandler({
    getEnv: (name) => checkoutEnvironment[name],
    async consumeGatewayNonce() { return true; },
    createServices: async () => ({ repository, stripe })
  });
  return { handler, calls, attempt };
}

async function checkoutRequest(body = validCheckoutBody, options = {}) {
  const canonicalUrl = "http://127.0.0.1:54321/functions/v1/stripe-checkout";
  const runtimeUrl = "http://127.0.0.1:54321/stripe-checkout";
  const method = options.method ?? "POST";
  const rawBody = options.rawBody ?? (method === "GET" ? "" : JSON.stringify(body));
  const assertionHeaders = options.withGatewayAuth === false
    ? {}
    : await gatewayAssertionHeaders(canonicalUrl, method, rawBody);
  const request = {
    method,
    headers: {
      origin: options.origin ?? "http://127.0.0.1:5500",
      "content-type": "application/json",
      ...assertionHeaders,
      ...(options.invalidGatewaySignature ? {
        "x-beauty-pluz-gateway-signature": "invalid"
      } : {})
    }
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    request.body = rawBody;
  }
  return new Request(runtimeUrl, request);
}

const webhookEnvironment = {
  STRIPE_SECRET_KEY: "sk_test_unit",
  STRIPE_WEBHOOK_SECRET: "whsec_unit",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-service-role-test-key"
};

function stripeEvent(type = "checkout.session.completed", overrides = {}) {
  return {
    id: "evt_unit_test_0001",
    type,
    data: {
      object: {
        id: "cs_test_checkout_1",
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        amount_total: 2100,
        currency: "gbp",
        payment_intent: "pi_test_1",
        client_reference_id: "2fa85f64-5717-4562-b3fc-2c963f66afa7",
        metadata: {
          order_id: "2fa85f64-5717-4562-b3fc-2c963f66afa7",
          checkout_attempt_id: "2fa85f64-5717-4562-b3fc-2c963f66afa6",
          attempt_key: "checkout-test-key-0001"
        },
        ...overrides
      }
    }
  };
}

function webhookHarness(options = {}) {
  const calls = { rawBodies: [], processInputs: [] };
  const services = {
    async retrieveEvent(rawBody, signature, secret) {
      calls.rawBodies.push({ rawBody, signature, secret });
      if (options.retrieveEvent) return await options.retrieveEvent(rawBody, signature, secret);
      return stripeEvent(options.eventType, options.sessionOverrides);
    },
    async getAttemptByKey() {
      if (options.getAttemptByKey) return await options.getAttemptByKey();
      return {
        id: "2fa85f64-5717-4562-b3fc-2c963f66afa6",
        order_id: "2fa85f64-5717-4562-b3fc-2c963f66afa7",
        attempt_key: "checkout-test-key-0001",
        stripe_checkout_session_id: options.savedSessionId ?? "cs_test_checkout_1"
      };
    },
    async processEvent(input) {
      calls.processInputs.push(input);
      if (options.processEvent) return await options.processEvent(input);
      return options.result ?? "paid";
    }
  };
  const handler = createWebhookHandler({
    getEnv: (name) => webhookEnvironment[name],
    createServices: async () => services
  });
  return { handler, calls };
}

function webhookRequest(rawBody = '{ "raw": "signed bytes" }', signature = "t=1,v1=test") {
  const headers = {};
  if (signature !== null) headers["stripe-signature"] = signature;
  return new Request("http://127.0.0.1:54321/functions/v1/stripe-webhook", {
    method: "POST",
    headers,
    body: rawBody
  });
}

test("checkout rejects unsupported methods and invalid origins", async () => {
  const { handler } = checkoutHarness();
  assert.equal((await handler(await checkoutRequest(undefined, { method: "GET" }))).status, 401);
  assert.equal((await handler(await checkoutRequest(validCheckoutBody, { origin: "https://attacker.invalid" }))).status, 403);
});

test("gateway maps only exact Edge Runtime paths to canonical public paths", () => {
  const mappings = {
    "/stripe-checkout": "/functions/v1/stripe-checkout",
    "/stripe-guest-handoff": "/functions/v1/stripe-guest-handoff",
    "/stripe-guest-status": "/functions/v1/stripe-guest-status",
    "/stripe-checkout-recover": "/functions/v1/stripe-checkout-recover",
    "/stripe-webhook": "/functions/v1/stripe-webhook"
  };
  for (const [runtimePath, canonicalPath] of Object.entries(mappings)) {
    assert.equal(canonicalGatewayPath(runtimePath), canonicalPath);
  }
  for (const path of [
    "/functions/v1/stripe-guest-status",
    "/stripe-guest-status/extra",
    "/other/stripe-guest-status",
    "/stripe-unknown"
  ]) {
    assert.equal(canonicalGatewayPath(path), null);
  }
});

test("guest Edge Functions reject direct requests without a valid gateway assertion", async () => {
  const checkout = checkoutHarness();
  assert.equal((await checkout.handler(await checkoutRequest(validCheckoutBody, {
    withGatewayAuth: false
  }))).status, 401);
  assert.equal((await checkout.handler(await checkoutRequest(validCheckoutBody, {
    invalidGatewaySignature: true
  }))).status, 401);
  assert.equal(checkout.calls.attemptInputs.length, 0);

  let guestServiceCalls = 0;
  const guestDependencies = {
    getEnv: (name) => guestEnvironment[name],
    async consumeGatewayNonce() { return true; },
    async createServices() {
      guestServiceCalls += 1;
      throw new Error("Unauthorized request must not create services");
    }
  };
  for (const handler of [
    createGuestHandoffHandler(guestDependencies),
    createGuestStatusHandler(guestDependencies)
  ]) {
    const response = await handler(await guestRequest("statusToken", "S".repeat(43), {
      withGatewayAuth: false
    }));
    assert.equal(response.status, 401);
  }

  const recovery = createCheckoutRecoveryHandler({
    getEnv: (name) => checkoutEnvironment[name],
    async createServices() {
      guestServiceCalls += 1;
      throw new Error("Unauthorized request must not create services");
    }
  });
  const directRecovery = new Request(
    "http://127.0.0.1:54321/functions/v1/stripe-checkout-recover",
    {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:5500",
        "content-type": "application/json"
      },
      body: JSON.stringify({ recoveryToken: "R".repeat(43) })
    }
  );
  assert.equal((await recovery(directRecovery)).status, 401);
  assert.equal(guestServiceCalls, 0);

  const missingSecret = createGuestStatusHandler({
    getEnv: (name) => name === "GUEST_GATEWAY_PUBLIC_KEY" ? undefined : guestEnvironment[name],
    async createServices() {
      guestServiceCalls += 1;
      throw new Error("Missing gateway configuration must fail closed");
    }
  });
  assert.equal((await missingSecret(await guestRequest("statusToken", "S".repeat(43)))).status, 503);
  assert.equal(guestServiceCalls, 0);
});

test("checkout rejects unknown browser-supplied price fields", async () => {
  const { handler, calls } = checkoutHarness();
  const malicious = structuredClone(validCheckoutBody);
  malicious.items[0].price = 0.01;
  assert.equal((await handler(await checkoutRequest(malicious))).status, 400);
  assert.equal(calls.attemptInputs.length, 0);
});

test("checkout builds GBP line items from the database snapshot, not browser prices", async () => {
  const { handler, calls } = checkoutHarness();
  const response = await handler(await checkoutRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: "https://checkout.stripe.com/c/pay/cs_test_checkout_1"
  });
  assert.equal(calls.createSession.length, 1);
  assert.deepEqual(calls.createSession[0].params.line_items, [
    {
      price_data: {
        currency: "gbp",
        product_data: { name: "Trusted product" },
        unit_amount: 850
      },
      quantity: 2
    },
    {
      price_data: {
        currency: "gbp",
        product_data: { name: "Delivery" },
        unit_amount: 400
      },
      quantity: 1
    }
  ]);
  assert.equal(calls.attemptInputs[0].p_items[0].product_id, "bp-test-product");
  assert.equal("price" in calls.attemptInputs[0].p_items[0], false);
  assert.equal(calls.capabilities.length, 1);
  assert.equal(calls.capabilities[0].p_checkout_attempt_id, "2fa85f64-5717-4562-b3fc-2c963f66afa6");
  assert.equal(calls.rateLimit.length, 3);
  const successUrl = new URL(calls.createSession[0].params.success_url);
  const cancelUrl = new URL(calls.createSession[0].params.cancel_url);
  assert.match(successUrl.hash, /^#handoff=[A-Za-z0-9_-]{43}$/);
  assert.equal(cancelUrl.hash, successUrl.hash);
  assert.equal(successUrl.searchParams.get("session_id"), "{CHECKOUT_SESSION_ID}");
});

test("checkout rate limiting fails closed and returns Retry-After", async () => {
  const { handler, calls } = checkoutHarness({
    consumeRateLimit: async () => ({ allowed: false, retry_after_seconds: 37 })
  });
  const response = await handler(await checkoutRequest());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "37");
  assert.deepEqual(await response.json(), {
    error: "Too many checkout attempts. Please wait and try again."
  });
  assert.equal(calls.attemptInputs.length, 0);
});

test("checkout returns a safe error when configuration is missing", async () => {
  const handler = createCheckoutHandler({
    getEnv: () => undefined,
    createServices: async () => {
      throw new Error("Services should not be created without configuration");
    }
  });
  const response = await handler(await checkoutRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Checkout is temporarily unavailable." });
});

test("Stripe timeout retries use the same provider idempotency key", async () => {
  let attempts = 0;
  const { handler, calls } = checkoutHarness({
    createSession: async (params) => {
      attempts += 1;
      if (attempts === 1) throw new Error("network timeout");
      return {
        id: "cs_test_checkout_1",
        url: "https://checkout.stripe.com/c/pay/cs_test_checkout_1",
        status: "open",
        expires_at: params.expires_at
      };
    }
  });
  assert.equal((await handler(await checkoutRequest())).status, 503);
  assert.equal((await handler(await checkoutRequest())).status, 200);
  assert.equal(calls.createSession.length, 2);
  assert.equal(calls.createSession[0].idempotencyKey, calls.createSession[1].idempotencyKey);
});

test("checkout reuses an attached open Stripe Session", async () => {
  const { handler, calls, attempt } = checkoutHarness();
  attempt.stripe_checkout_session_id = "cs_existing_session";
  attempt.status = "created";
  const response = await handler(await checkoutRequest());
  assert.equal(response.status, 200);
  assert.equal(calls.createSession.length, 0);
  assert.deepEqual(calls.retrieveSession, ["cs_existing_session"]);
});

test("checkout request body limits are enforced", async () => {
  const { handler, calls } = checkoutHarness();
  const response = await handler(await checkoutRequest(undefined, {
    rawBody: `"${"x".repeat(16 * 1024)}"`
  }));
  assert.equal(response.status, 401);
  assert.equal(calls.attemptInputs.length, 0);
});

test("guest capabilities are purpose-separated high-entropy values stored by digest", async () => {
  const orderId = "2fa85f64-5717-4562-b3fc-2c963f66afa7";
  const attemptId = "2fa85f64-5717-4562-b3fc-2c963f66afa6";
  const secret = checkoutEnvironment.CHECKOUT_CAPABILITY_SECRET;
  const handoff = await deriveGuestCapability(secret, "handoff", attemptId);
  const nextAttemptHandoff = await deriveGuestCapability(
    secret,
    "handoff",
    "3fa85f64-5717-4562-b3fc-2c963f66afa6"
  );
  const status = await deriveGuestCapability(secret, "status", orderId);
  const recovery = await deriveGuestCapability(secret, "recovery", orderId);
  assert.match(handoff, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(handoff, status);
  assert.notEqual(handoff, nextAttemptHandoff);
  assert.notEqual(status, recovery);
  assert.notEqual(await hashGuestCapability(handoff), handoff);
});

const guestEnvironment = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-service-role-test-key",
  GUEST_GATEWAY_PUBLIC_KEY: gatewayTestKeys.publicKey,
  CHECKOUT_CAPABILITY_SECRET: checkoutEnvironment.CHECKOUT_CAPABILITY_SECRET,
  CHECKOUT_RATE_LIMIT_SECRET: checkoutEnvironment.CHECKOUT_RATE_LIMIT_SECRET,
  CHECKOUT_ALLOWED_ORIGINS: "http://127.0.0.1:5500"
};

async function guestRequest(tokenKey, token, options = {}) {
  const endpoint = tokenKey === "handoffToken"
    ? "stripe-guest-handoff"
    : tokenKey === "recoveryToken"
      ? "stripe-checkout-recover"
      : "stripe-guest-status";
  const canonicalUrl = `http://127.0.0.1:54321/functions/v1/${endpoint}`;
  const runtimeUrl = `http://127.0.0.1:54321/${endpoint}`;
  const body = JSON.stringify({ [tokenKey]: token });
  const assertionHeaders = options.withGatewayAuth === false
    ? {}
    : await gatewayAssertionHeaders(canonicalUrl, "POST", body);
  const headers = {
    origin: "http://127.0.0.1:5500",
    "content-type": "application/json",
    ...assertionHeaders,
    ...(options.invalidGatewaySignature ? {
      "x-beauty-pluz-gateway-signature": "invalid"
    } : {})
  };
  return new Request(runtimeUrl, {
    method: "POST",
    headers,
    body
  });
}

test("guest handoff exchanges a valid capability and returns only safe status plus scoped tokens", async () => {
  const orderId = "2fa85f64-5717-4562-b3fc-2c963f66afa7";
  const limits = [];
  const handler = createGuestHandoffHandler({
    getEnv: (name) => guestEnvironment[name],
    async consumeGatewayNonce() { return true; },
    createServices: async () => ({
      async exchangeHandoff() {
        return {
          order_id: orderId,
          order_reference: "2c963f66",
          payment_status: "pending"
        };
      },
      async getStatus() { throw new Error("Handoff should include its status snapshot"); },
      async consumeRateLimit(hash, limit, windowSeconds) {
        limits.push({ hash, limit, windowSeconds });
        return { allowed: true, retry_after_seconds: 0 };
      }
    })
  });
  const token = await deriveGuestCapability(
    guestEnvironment.CHECKOUT_CAPABILITY_SECRET,
    "handoff",
    "2fa85f64-5717-4562-b3fc-2c963f66afa6"
  );
  const response = await handler(await guestRequest("handoffToken", token));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.orderReference, "2c963f66");
  assert.equal(result.paymentStatus, "pending");
  assert.equal("customerEmail" in result, false);
  assert.equal("shippingAddress" in result, false);
  assert.equal(result.statusToken, await deriveGuestCapability(
    guestEnvironment.CHECKOUT_CAPABILITY_SECRET,
    "status",
    orderId
  ));
  assert.equal(typeof result.recoveryToken, "string");
  assert.deepEqual(limits.map(({ limit, windowSeconds }) => [limit, windowSeconds]), [
    [100, 60],
    [10, 300]
  ]);
});

test("guest status rejects unknown capabilities and fails closed when rate limiting is unavailable", async () => {
  const handler = createGuestStatusHandler({
    getEnv: (name) => guestEnvironment[name],
    async consumeGatewayNonce() { return true; },
    createServices: async () => ({
      async getStatus() { return null; },
      async consumeRateLimit() { return { allowed: false, retry_after_seconds: 45 }; }
    })
  });
  const token = "A".repeat(43);
  const response = await handler(await guestRequest("statusToken", token));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "45");

  const unknownHandler = createGuestStatusHandler({
    getEnv: (name) => guestEnvironment[name],
    async consumeGatewayNonce() { return true; },
    createServices: async () => ({
      async getStatus() { return null; },
      async consumeRateLimit() { return { allowed: true, retry_after_seconds: 0 }; }
    })
  });
  assert.equal((await unknownHandler(await guestRequest("statusToken", token))).status, 404);

  const failingHandler = createGuestStatusHandler({
    getEnv: (name) => guestEnvironment[name],
    async consumeGatewayNonce() { return true; },
    createServices: async () => ({
      async getStatus() { throw new Error("database unavailable"); },
      async consumeRateLimit() { throw new Error("limiter unavailable"); }
    })
  });
  const unavailable = await failingHandler(await guestRequest("statusToken", token));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: "Order status is temporarily unavailable."
  });
});

test("checkout recovery retries reuse the database-backed attempt and active Stripe Session", async () => {
  const attemptKey = "recovery-logical-attempt-0001";
  const attempt = {
    id: "2fa85f64-5717-4562-b3fc-2c963f66afa6",
    order_id: "2fa85f64-5717-4562-b3fc-2c963f66afa7",
    attempt_key: attemptKey,
    stripe_checkout_session_id: "cs_test_recovery_existing",
    status: "created",
    amount_total: 2100,
    currency: "GBP",
    expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    customer_email: "customer@example.invalid"
  };
  const calls = { recovery: [], retrieve: [], create: [] };
  const handler = createCheckoutRecoveryHandler({
    getEnv: (name) => checkoutEnvironment[name],
    async consumeGatewayNonce() { return true; },
    createServices: async () => ({
      repository: {
        async recoverAttempt(input) {
          calls.recovery.push(input);
          return {
            order_id: attempt.order_id,
            attempt_id: attempt.id,
            amount_total: attempt.amount_total,
            currency: attempt.currency,
            reused: calls.recovery.length > 1
          };
        },
        async getAttempt() { return attempt; },
        async getOrderItems() { throw new Error("Active session should be reused"); },
        async attachSession() { throw new Error("Active session should not be reattached"); },
        async registerCapabilities() {},
        async consumeRateLimit() { return { allowed: true, retry_after_seconds: 0 }; }
      },
      stripe: {
        async createSession(params, idempotencyKey) {
          calls.create.push({ params, idempotencyKey });
          throw new Error("Active session should be reused");
        },
        async retrieveSession(sessionId) {
          calls.retrieve.push(sessionId);
          return {
            id: sessionId,
            url: "https://checkout.stripe.com/c/pay/cs_test_recovery_existing",
            status: "open",
            expires_at: Math.floor(Date.parse(attempt.expires_at) / 1000)
          };
        }
      }
    })
  });
  const request = async () => {
    const canonicalUrl = "http://127.0.0.1:54321/functions/v1/stripe-checkout-recover";
    const runtimeUrl = "http://127.0.0.1:54321/stripe-checkout-recover";
    const body = JSON.stringify({ recoveryToken: "A".repeat(43) });
    return new Request(runtimeUrl, {
      method: "POST",
      headers: {
      origin: "http://127.0.0.1:5500",
      "content-type": "application/json",
        ...await gatewayAssertionHeaders(canonicalUrl, "POST", body)
      },
      body
    });
  };

  const first = await handler(await request());
  const retry = await handler(await request());
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.deepEqual(await first.json(), {
    url: "https://checkout.stripe.com/c/pay/cs_test_recovery_existing"
  });
  assert.equal(calls.recovery.length, 2);
  assert.equal(calls.recovery[0].p_recovery_hash, calls.recovery[1].p_recovery_hash);
  assert.equal("p_attempt_key" in calls.recovery[0], false);
  assert.deepEqual(calls.retrieve, ["cs_test_recovery_existing", "cs_test_recovery_existing"]);
  assert.equal(calls.create.length, 0);
});

test("checkout recovery applies a global limit before per-capability accounting", async () => {
  let rateLimitCalls = 0;
  const handler = createCheckoutRecoveryHandler({
    getEnv: (name) => checkoutEnvironment[name],
    async consumeGatewayNonce() { return true; },
    createServices: async () => ({
      repository: {
        async consumeRateLimit(hash, limit, windowSeconds) {
          rateLimitCalls += 1;
          assert.match(hash, /^[0-9a-f]{64}$/);
          assert.equal(limit, 100);
          assert.equal(windowSeconds, 60);
          return { allowed: false, retry_after_seconds: 31 };
        }
      },
      stripe: {}
    })
  });
  const canonicalUrl = "http://127.0.0.1:54321/functions/v1/stripe-checkout-recover";
  const runtimeUrl = "http://127.0.0.1:54321/stripe-checkout-recover";
  const body = JSON.stringify({ recoveryToken: "A".repeat(43) });
  const response = await handler(new Request(
    runtimeUrl,
    {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:5500",
        "content-type": "application/json",
        ...await gatewayAssertionHeaders(canonicalUrl, "POST", body)
      },
      body
    }
  ));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "31");
  assert.equal(rateLimitCalls, 1);
});

test("webhook rejects missing and invalid signatures before processing", async () => {
  const { handler, calls } = webhookHarness({
    retrieveEvent: async () => {
      throw new Error("invalid signature");
    }
  });
  assert.equal((await handler(webhookRequest("{}", null))).status, 400);
  assert.equal((await handler(webhookRequest("{}", "bad-signature"))).status, 400);
  assert.equal(calls.processInputs.length, 0);
});

test("webhook returns a safe error when required configuration is missing", async () => {
  const handler = createWebhookHandler({
    getEnv: () => undefined,
    createServices: async () => {
      throw new Error("Services should not be created without configuration");
    }
  });
  const response = await handler(webhookRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Webhook processing is temporarily unavailable." });
});

test("webhook signature verification receives the exact raw body", async () => {
  const rawBody = '{ "id": "evt_raw_body_test" }\n';
  const { handler, calls } = webhookHarness();
  assert.equal((await handler(webhookRequest(rawBody))).status, 200);
  assert.equal(calls.rawBodies[0].rawBody, rawBody);
  assert.equal(calls.rawBodies[0].secret, "whsec_unit");
});

test("webhook forwards verified amount, currency, and Session ID for database validation", async () => {
  const { handler, calls } = webhookHarness({
    savedSessionId: "cs_expected_session",
    sessionOverrides: { amount_total: 2101, currency: "usd", id: "cs_mismatch" },
    result: "mismatch"
  });
  assert.equal((await handler(webhookRequest())).status, 200);
  assert.equal(calls.processInputs[0].p_amount_total, 2101);
  assert.equal(calls.processInputs[0].p_currency, "USD");
  assert.equal(calls.processInputs[0].p_stripe_session_id, "cs_mismatch");
  assert.equal(calls.processInputs[0].p_action, "paid");
});

test("a duplicate event is delegated to database idempotency", async () => {
  let count = 0;
  const { handler, calls } = webhookHarness({
    processEvent: async () => ++count === 1 ? "paid" : "duplicate"
  });
  assert.equal((await handler(webhookRequest())).status, 200);
  assert.equal((await handler(webhookRequest())).status, 200);
  assert.equal(calls.processInputs.length, 2);
  assert.equal(calls.processInputs[0].p_event_id, calls.processInputs[1].p_event_id);
});

test("out-of-order failure after payment preserves the database's paid result", async () => {
  const { handler, calls } = webhookHarness({
    eventType: "checkout.session.async_payment_failed",
    sessionOverrides: { payment_status: "unpaid", payment_intent: null },
    result: "already_paid"
  });
  const response = await handler(webhookRequest());
  assert.equal(response.status, 200);
  assert.equal(calls.processInputs[0].p_action, "failed");
});

test("a failed-payment event is processed without treating the redirect as payment", async () => {
  const { handler, calls } = webhookHarness({
    eventType: "checkout.session.async_payment_failed",
    sessionOverrides: { payment_status: "unpaid", payment_intent: null },
    result: "failed"
  });
  assert.equal((await handler(webhookRequest())).status, 200);
  assert.equal(calls.processInputs[0].p_action, "failed");
});

test("asynchronous payment success is forwarded as a paid event", async () => {
  const { handler, calls } = webhookHarness({
    eventType: "checkout.session.async_payment_succeeded",
    result: "paid"
  });
  assert.equal((await handler(webhookRequest())).status, 200);
  assert.equal(calls.processInputs[0].p_action, "paid");
});

test("inconsistent asynchronous success is retried instead of silently ignored", async () => {
  const { handler, calls } = webhookHarness({
    eventType: "checkout.session.async_payment_succeeded",
    sessionOverrides: { payment_status: "unpaid" }
  });
  assert.equal((await handler(webhookRequest())).status, 503);
  assert.equal(calls.processInputs.length, 0);
});

test("an unpaid completed session waits for its asynchronous payment event", async () => {
  const { handler, calls } = webhookHarness({
    sessionOverrides: { payment_status: "unpaid" }
  });
  assert.equal((await handler(webhookRequest())).status, 200);
  assert.equal(calls.processInputs.length, 0);
});

test("webhook rejects a successful-payment RPC failure so Stripe can retry", async () => {
  const { handler } = webhookHarness({
    processEvent: async () => {
      throw new Error("database unavailable");
    }
  });
  const response = await handler(webhookRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Webhook processing is temporarily unavailable." });
});

test("webhook records mismatched attempt references without applying their payment", async () => {
  const { handler, calls } = webhookHarness({
    sessionOverrides: {
      metadata: {
        order_id: "2fa85f64-5717-4562-b3fc-2c963f66afa7",
        checkout_attempt_id: "2fa85f64-5717-4562-b3fc-2c963f66afa6",
        attempt_key: "checkout-test-key-0001"
      }
    },
    getAttemptByKey: async () => null,
    result: "unmatched"
  });
  assert.equal((await handler(webhookRequest())).status, 200);
  assert.match(calls.processInputs[0].p_attempt_key, /^unmatched-evt_unit_test_0001$/);
});
