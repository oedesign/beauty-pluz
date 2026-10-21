import assert from "node:assert/strict";
import test from "node:test";
import { createCheckoutHandler } from "../functions/_shared/checkout.mjs";
import { createWebhookHandler } from "../functions/_shared/webhook.mjs";

const checkoutEnvironment = {
  STRIPE_SECRET_KEY: "sk_test_unit",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "local-service-role-test-key",
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
    attached: []
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
    createServices: async () => ({ repository, stripe })
  });
  return { handler, calls, attempt };
}

function checkoutRequest(body = validCheckoutBody, options = {}) {
  const request = {
    method: options.method ?? "POST",
    headers: {
      origin: options.origin ?? "http://127.0.0.1:5500",
      "content-type": "application/json"
    }
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    request.body = options.rawBody ?? JSON.stringify(body);
  }
  return new Request("http://127.0.0.1:54321/functions/v1/stripe-checkout", request);
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
  assert.equal((await handler(checkoutRequest(undefined, { method: "GET" }))).status, 405);
  assert.equal((await handler(checkoutRequest(validCheckoutBody, { origin: "https://attacker.invalid" }))).status, 403);
});

test("checkout rejects unknown browser-supplied price fields", async () => {
  const { handler, calls } = checkoutHarness();
  const malicious = structuredClone(validCheckoutBody);
  malicious.items[0].price = 0.01;
  assert.equal((await handler(checkoutRequest(malicious))).status, 400);
  assert.equal(calls.attemptInputs.length, 0);
});

test("checkout builds GBP line items from the database snapshot, not browser prices", async () => {
  const { handler, calls } = checkoutHarness();
  const response = await handler(checkoutRequest());
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
});

test("checkout returns a safe error when configuration is missing", async () => {
  const handler = createCheckoutHandler({
    getEnv: () => undefined,
    createServices: async () => {
      throw new Error("Services should not be created without configuration");
    }
  });
  const response = await handler(checkoutRequest());
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
  assert.equal((await handler(checkoutRequest())).status, 503);
  assert.equal((await handler(checkoutRequest())).status, 200);
  assert.equal(calls.createSession.length, 2);
  assert.equal(calls.createSession[0].idempotencyKey, calls.createSession[1].idempotencyKey);
});

test("checkout reuses an attached open Stripe Session", async () => {
  const { handler, calls, attempt } = checkoutHarness();
  attempt.stripe_checkout_session_id = "cs_existing_session";
  attempt.status = "created";
  const response = await handler(checkoutRequest());
  assert.equal(response.status, 200);
  assert.equal(calls.createSession.length, 0);
  assert.deepEqual(calls.retrieveSession, ["cs_existing_session"]);
});

test("checkout request body limits are enforced", async () => {
  const { handler, calls } = checkoutHarness();
  const response = await handler(checkoutRequest(undefined, {
    rawBody: `"${"x".repeat(16 * 1024)}"`
  }));
  assert.equal(response.status, 413);
  assert.equal(calls.attemptInputs.length, 0);
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
