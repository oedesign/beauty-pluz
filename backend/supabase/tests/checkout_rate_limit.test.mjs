import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  consumeCheckoutRequestLimit,
  createCheckoutRateLimitIdentity,
  normalizeCheckoutPhone,
} from "../functions/_shared/checkout-rate-limit.ts";

const hmacKey = "checkout-rate-limit-test-key-material-32-bytes";

test("normalizes national and international checkout phone input", () => {
  assert.equal(
    normalizeCheckoutPhone(" 0800 (123) 456 ", "ng"),
    "NG:0800123456",
  );
  assert.equal(
    normalizeCheckoutPhone("+234 800-123-456", "GB"),
    "GB:234800123456",
  );
  assert.equal(
    normalizeCheckoutPhone("+44 (0)20.1234-5678", "gb"),
    "GB:4402012345678",
  );
  assert.equal(
    normalizeCheckoutPhone("44 020-1234-5678", "GB"),
    normalizeCheckoutPhone("+44 (0)20.1234-5678", "gb"),
  );
});

test("rejects malformed or out-of-range phone and country input", () => {
  for (const [phone, country] of [
    ["1234", "GB"],
    ["1234567890123456", "GB"],
    ["+12345", "United Kingdom"],
    ["12345<script>", "GB"],
    ["     ", "GB"],
  ]) {
    assert.equal(normalizeCheckoutPhone(phone, country), null);
  }
});

test("creates domain-separated HMAC-SHA256 rate-limit identities", async () => {
  const phoneIdentity = await createCheckoutRateLimitIdentity(
    "checkout-phone",
    "GB:02012345678",
    hmacKey,
  );
  const expected = createHmac("sha256", hmacKey)
    .update("beauty-pluz:checkout-phone:v1:GB:02012345678")
    .digest("hex");
  assert.equal(phoneIdentity, expected);
  assert.match(phoneIdentity, /^[0-9a-f]{64}$/);

  const tokenIdentity = await createCheckoutRateLimitIdentity(
    "payment-token",
    "\\x" + "a".repeat(64),
    hmacKey,
  );
  assert.notEqual(tokenIdentity, phoneIdentity);
  assert.notEqual(
    tokenIdentity,
    await createCheckoutRateLimitIdentity(
      "payment-token",
      "\\x" + "a".repeat(64),
      `${hmacKey}-different`,
    ),
  );
});

test("rejects weak HMAC keys and empty identity values", async () => {
  await assert.rejects(
    createCheckoutRateLimitIdentity("checkout-phone", "GB:12345", "short"),
  );
  await assert.rejects(
    createCheckoutRateLimitIdentity("payment-token", "", hmacKey),
  );
});

test("allows, rejects, and fails closed on checkout rate-limit RPC responses", async () => {
  const previousDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  const previousFetch = globalThis.fetch;
  const requests = [];
  let rpcResponse = new Response("true", { status: 200 });

  Object.defineProperty(globalThis, "Deno", {
    configurable: true,
    value: {
      env: {
        get(name) {
          return {
            SUPABASE_URL: "https://supabase.example",
            SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
          }[name];
        },
      },
    },
  });
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return rpcResponse;
  };

  try {
    const identity = "ab".repeat(32);
    assert.equal(await consumeCheckoutRequestLimit(identity), true);
    rpcResponse = new Response("false", { status: 200 });
    assert.equal(await consumeCheckoutRequestLimit(identity), false);

    const rpcBody = JSON.parse(requests[0].init.body);
    assert.equal(rpcBody.p_identity_hash, `\\x${identity}`);
    assert.equal(requests[0].url.endsWith("/rpc/consume_checkout_request_limit"), true);

    rpcResponse = new Response("not-json", { status: 200 });
    await assert.rejects(consumeCheckoutRequestLimit(identity));
    rpcResponse = new Response("{}", { status: 503 });
    await assert.rejects(consumeCheckoutRequestLimit(identity));
    await assert.rejects(consumeCheckoutRequestLimit("invalid"));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDeno) {
      Object.defineProperty(globalThis, "Deno", previousDeno);
    } else {
      delete globalThis.Deno;
    }
  }
});
