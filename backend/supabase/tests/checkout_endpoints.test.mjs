import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckoutRateLimitIdentity,
  normalizeCheckoutPhone,
} from "../functions/_shared/checkout-rate-limit.ts";
import { hashCheckoutAccessToken } from "../functions/_shared/sumup.ts";

const hmacKey = "checkout-endpoint-test-key-material-at-least-32-bytes";
const serviceUrl = "https://supabase.example";
const serviceRoleKey = "test-service-role-key";
const orderId = "5a3f16d0-3301-42b8-a4bb-628ef5fa50d6";
const checkoutAccessToken = Buffer.alloc(32, 7).toString("base64url");
const handlers = [];
const environment = {
  CHECKOUT_RATE_LIMIT_HMAC_KEY: hmacKey,
  SUPABASE_URL: serviceUrl,
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  SUMUP_ENVIRONMENT: "sandbox",
  SUMUP_SANDBOX_API_KEY: "test-sandbox-key",
  SUMUP_SANDBOX_MERCHANT_CODE: "MERCHANT123",
  BEAUTY_PLUZ_SITE_URL: "https://beautypluz.example",
};

Object.defineProperty(globalThis, "Deno", {
  configurable: true,
  value: {
    env: { get: (name) => environment[name] },
    serve: (handler) => handlers.push(handler),
  },
});

await import("../functions/create-checkout-order/index.ts");
await import("../functions/verify-sumup-payment/index.ts");
const createCheckoutHandler = handlers[0];
const verifyPaymentHandler = handlers[1];

function checkoutPayload(overrides = {}) {
  return {
    idempotencyKey: "00c817d5-bd48-4f16-a077-c5e98d15a86d",
    checkoutAccessToken,
    customerName: "Test Customer",
    customerPhone: "+234 800 123 4567",
    shippingAddress: "1 Test Street",
    countryCode: "NG",
    postalCode: "100001",
    items: [{ id: "product-1", quantity: 1 }],
    ...overrides,
  };
}

function request(body, headers = {}) {
  return new Request("https://functions.example/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function withMockedRpc(run) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let limiterStatus = 200;
  let limiterAllowed = true;
  globalThis.fetch = async (url, init) => {
    const name = new URL(url).pathname.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ name, body });

    if (name === "consume_checkout_request_limit") {
      return new Response(
        limiterStatus === 200 ? JSON.stringify(limiterAllowed) : "{}",
        { status: limiterStatus },
      );
    }
    if (name === "create_checkout_order") {
      return new Response(JSON.stringify(orderId), { status: 200 });
    }
    if (name === "claim_sumup_checkout") {
      return new Response(JSON.stringify({
        checkoutReference: "checkout-reference",
        checkoutId: null,
        hostedCheckoutUrl: null,
        state: "creating",
        claimed: false,
        amountMinor: 1460,
        currency: "GBP",
        validUntil: "2026-11-02T00:00:00Z",
      }), { status: 200 });
    }
    if (name === "get_sumup_checkout_for_verification") {
      return new Response(JSON.stringify({
        orderId,
        checkoutReference: "checkout-reference",
        checkoutId: "checkout-123",
        hostedCheckoutUrl: "https://checkout.sumup.com/pay/checkout-123",
        state: "paid",
        merchantCode: "MERCHANT123",
        amountMinor: 1460,
        currency: "GBP",
      }), { status: 200 });
    }
    throw new Error(`Unexpected RPC: ${name}`);
  };

  try {
    await run({
      calls,
      setLimiter(allowed, status = 200) {
        limiterAllowed = allowed;
        limiterStatus = status;
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("checkout rate-limits validated phones without requiring a trusted IP header", async () => {
  await withMockedRpc(async ({ calls }) => {
    const payload = checkoutPayload();
    const result = await createCheckoutHandler(request(payload, {
      "cf-connecting-ip": "caller-controlled",
    }));
    assert.equal(result.status, 202);
    assert.deepEqual(await result.json(), {
      orderId,
      paymentStatus: "pending",
    });
    assert.deepEqual(calls.map(({ name }) => name), [
      "consume_checkout_request_limit",
      "create_checkout_order",
      "claim_sumup_checkout",
    ]);

    const normalizedPhone = normalizeCheckoutPhone(
      payload.customerPhone,
      payload.countryCode,
    );
    const expectedIdentity = await createCheckoutRateLimitIdentity(
      "checkout-phone",
      normalizedPhone,
      hmacKey,
    );
    assert.equal(
      calls[0].body.p_identity_hash,
      `\\x${expectedIdentity}`,
    );
    assert.equal(
      JSON.stringify(calls[0].body).includes(payload.customerPhone),
      false,
    );
  });
});

test("checkout returns 400 for invalid phone and 429 when the limiter denies it", async () => {
  await withMockedRpc(async ({ calls, setLimiter }) => {
    const invalid = await createCheckoutHandler(request(
      checkoutPayload({ customerPhone: "12345<script>" }),
    ));
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 0);

    setLimiter(false);
    const denied = await createCheckoutHandler(request(checkoutPayload()));
    assert.equal(denied.status, 429);
    assert.deepEqual(calls.map(({ name }) => name), [
      "consume_checkout_request_limit",
    ]);

    setLimiter(true, 503);
    const unavailable = await createCheckoutHandler(request(checkoutPayload()));
    assert.equal(unavailable.status, 503);
    assert.deepEqual(calls.map(({ name }) => name), [
      "consume_checkout_request_limit",
      "consume_checkout_request_limit",
    ]);
  });
});

test("payment verification rate-limits the validated access token and succeeds", async () => {
  await withMockedRpc(async ({ calls }) => {
    const result = await verifyPaymentHandler(request({
      orderId,
      checkoutAccessToken,
    }));
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { paymentStatus: "paid" });
    assert.deepEqual(calls.map(({ name }) => name), [
      "consume_checkout_request_limit",
      "get_sumup_checkout_for_verification",
    ]);

    const tokenHash = await hashCheckoutAccessToken(checkoutAccessToken);
    const expectedIdentity = await createCheckoutRateLimitIdentity(
      "payment-token",
      tokenHash,
      hmacKey,
    );
    assert.equal(
      calls[0].body.p_identity_hash,
      `\\x${expectedIdentity}`,
    );
    assert.equal(
      JSON.stringify(calls[0].body).includes(checkoutAccessToken),
      false,
    );
  });
});

test("payment verification rejects invalid tokens and returns 429 or 503 fail-closed", async () => {
  await withMockedRpc(async ({ calls, setLimiter }) => {
    const invalid = await verifyPaymentHandler(request({
      orderId,
      checkoutAccessToken: "invalid-token",
    }));
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 0);

    setLimiter(false);
    const denied = await verifyPaymentHandler(request({
      orderId,
      checkoutAccessToken,
    }));
    assert.equal(denied.status, 429);

    setLimiter(true, 503);
    const unavailable = await verifyPaymentHandler(request({
      orderId,
      checkoutAccessToken,
    }));
    assert.equal(unavailable.status, 503);
  });
});
