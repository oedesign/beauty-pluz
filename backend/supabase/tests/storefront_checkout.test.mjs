import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  clearCheckoutReturnState,
  readCheckoutReturnState,
  writeCheckoutReturnState
} from "../../../js/checkout-return-state.mjs";
import {
  buildCheckoutRequest,
  CheckoutClientError,
  clearCheckoutAttemptKeys,
  createSingleFlight,
  getCheckoutEndpoint,
  getGuestEndpoint,
  getOrCreateIdempotencyKey,
  requestStripeCheckout
} from "../../../js/stripe-checkout.mjs";

const cartItems = [
  {
    id: "sp-001",
    name: "Browser product name",
    price: 0.01,
    quantity: 2
  }
];
const customer = {
  name: "Jane Doe",
  email: "Jane@example.com",
  phone: "+447823894470",
  shippingAddress: "1 Market Street, London, SW1A 1AA"
};

test("empty baskets and invalid product IDs or quantities are rejected", () => {
  assert.throws(() => buildCheckoutRequest([], customer), CheckoutClientError);
  assert.throws(() => buildCheckoutRequest([null], customer), CheckoutClientError);
  assert.throws(() => buildCheckoutRequest([{ id: "", quantity: 1 }], customer), CheckoutClientError);
  assert.throws(() => buildCheckoutRequest([{ id: "sp-001", quantity: 0 }], customer), CheckoutClientError);
  assert.throws(() => buildCheckoutRequest([{ id: "sp-001", quantity: 101 }], customer), CheckoutClientError);
});

test("checkout request matches the backend contract and excludes browser prices", () => {
  const payload = buildCheckoutRequest(cartItems, customer, "checkout-attempt-0001");
  assert.deepEqual(payload, {
    idempotencyKey: "checkout-attempt-0001",
    customer: {
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "+447823894470",
      shippingAddress: "1 Market Street, London, SW1A 1AA"
    },
    items: [{ productId: "sp-001", quantity: 2 }]
  });
  assert.equal("price" in payload.items[0], false);
  assert.equal("total" in payload, false);
  assert.equal("currency" in payload, false);
});

test("checkout idempotency keys are reused for the same basket and details", async () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); }
  };
  const basis = buildCheckoutRequest(cartItems, customer);
  const first = await getOrCreateIdempotencyKey(basis, { crypto: webcrypto, storage });
  const second = await getOrCreateIdempotencyKey(basis, { crypto: webcrypto, storage });
  const changed = await getOrCreateIdempotencyKey(
    buildCheckoutRequest([{ id: "sp-001", quantity: 3 }], customer),
    { crypto: webcrypto, storage }
  );
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /^[A-Za-z0-9_-]{16,64}$/);
});

test("checkout idempotency still reuses a key when browser storage is unavailable", async () => {
  const basis = buildCheckoutRequest(cartItems, customer);
  const unavailableStorage = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); }
  };
  const first = await getOrCreateIdempotencyKey(basis, {
    crypto: webcrypto,
    storage: unavailableStorage
  });
  const second = await getOrCreateIdempotencyKey(basis, {
    crypto: webcrypto,
    storage: unavailableStorage
  });
  assert.equal(first, second);
});

test("verified payment clears cart-specific checkout keys for a later purchase", async () => {
  const values = new Map([
    ["beautyPluzStripeCheckout:one", "first-attempt-key"],
    ["unrelated-preference", "keep"]
  ]);
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); }
  };
  clearCheckoutAttemptKeys(storage);
  assert.deepEqual([...values.entries()], [["unrelated-preference", "keep"]]);
});

test("checkout return capabilities survive page refresh in tab-scoped storage", () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
  const handoffToken = "h".repeat(43);
  const statusToken = "s".repeat(43);
  const recoveryToken = "r".repeat(43);

  assert.equal(writeCheckoutReturnState({ handoffToken }, storage), true);
  assert.deepEqual(readCheckoutReturnState(storage), { handoffToken });
  assert.equal(
    writeCheckoutReturnState({ statusToken, recoveryToken }, storage),
    true
  );
  assert.deepEqual(readCheckoutReturnState(storage), { statusToken });
  assert.equal(writeCheckoutReturnState({ statusToken: "invalid" }, storage), false);
  assert.deepEqual(readCheckoutReturnState(storage), { statusToken });
  assert.equal(clearCheckoutReturnState(storage), true);
  assert.equal(readCheckoutReturnState(storage), null);
});

test("checkout return state fails safely when tab storage is unavailable or corrupt", () => {
  const unavailable = {
    getItem() { throw new Error("storage unavailable"); },
    setItem() { throw new Error("storage unavailable"); },
    removeItem() { throw new Error("storage unavailable"); }
  };
  const corrupt = { getItem() { return "{not-json"; } };

  assert.equal(readCheckoutReturnState(unavailable), null);
  assert.equal(writeCheckoutReturnState({ handoffToken: "h".repeat(43) }, unavailable), false);
  assert.equal(clearCheckoutReturnState(unavailable), false);
  assert.equal(readCheckoutReturnState(corrupt), null);
});

test("double submissions share one in-flight checkout operation", async () => {
  let callCount = 0;
  let finish;
  const action = createSingleFlight(() => {
    callCount += 1;
    if (callCount > 1) return Promise.resolve("started");
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = action();
  const second = action();
  assert.equal(callCount, 1);
  assert.equal(await second, undefined);
  finish("started");
  assert.equal(await first, "started");
  assert.equal(await action(), "started");
  assert.equal(callCount, 2);
});

test("guest checkout endpoints require the configured gateway origin", () => {
  assert.equal(
    getCheckoutEndpoint({ guestCheckoutGatewayUrl: "https://checkout.example.com/" }),
    "https://checkout.example.com/stripe-checkout"
  );
  assert.throws(() => getCheckoutEndpoint({}), CheckoutClientError);
  assert.throws(
    () => getCheckoutEndpoint({ supabaseUrl: "https://project-ref.supabase.co" }),
    CheckoutClientError
  );
  assert.throws(
    () => getCheckoutEndpoint({ guestCheckoutGatewayUrl: "http://example.invalid" }),
    CheckoutClientError
  );
  assert.equal(
    getGuestEndpoint({ guestCheckoutGatewayUrl: "https://checkout.example.com" }, "stripe-guest-status"),
    "https://checkout.example.com/stripe-guest-status"
  );
  assert.throws(
    () => getGuestEndpoint(
      { guestCheckoutGatewayUrl: "https://checkout.example.com" },
      "stripe-webhook"
    ),
    CheckoutClientError
  );
});

test("backend failures and network errors do not return a redirect URL", async () => {
  await assert.rejects(
    requestStripeCheckout("https://checkout.example.com/stripe-checkout", {}, async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Checkout is temporarily unavailable." })
    })),
    (error) => error instanceof CheckoutClientError && error.status === 503
  );
  await assert.rejects(
    requestStripeCheckout("https://checkout.example.com/stripe-checkout", {}, async () => {
      throw new Error("network unavailable");
    }),
    (error) => error instanceof CheckoutClientError && error.status === 0
  );
  await assert.rejects(
    requestStripeCheckout("https://checkout.example.com/stripe-checkout", {}, async () => ({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "23" }),
      json: async () => ({ error: "rate limited" })
    })),
    (error) => error instanceof CheckoutClientError &&
      error.status === 429 &&
      /23 seconds/.test(error.message)
  );
});

test("only a valid Stripe-hosted URL from a successful response is returned", async () => {
  const checkoutUrl = await requestStripeCheckout(
    "https://checkout.example.com/stripe-checkout",
    { idempotencyKey: "checkout-attempt-0001" },
    async (url, options) => {
      assert.equal(url, "https://checkout.example.com/stripe-checkout");
      assert.equal(options.method, "POST");
      assert.deepEqual(Object.keys(JSON.parse(options.body)), ["idempotencyKey"]);
      assert.deepEqual(Object.keys(options.headers), ["Content-Type"]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_123" })
      };
    }
  );
  assert.equal(checkoutUrl, "https://checkout.stripe.com/c/pay/cs_test_123");

  for (const url of [
    "http://checkout.stripe.com/c/pay/test",
    "https://attacker.invalid/c/pay/test",
    "https://checkout.stripe.com.attacker.invalid/c/pay/test"
  ]) {
    await assert.rejects(
      requestStripeCheckout(
        "https://checkout.example.com/stripe-checkout",
        {},
        async () => ({ ok: true, status: 200, json: async () => ({ url }) })
      ),
      CheckoutClientError
    );
  }
});

test("return pages do not clear carts, create sessions, or trust Stripe redirects as payment", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const [success, cancelled, returnScript, handoffScript, styles] = await Promise.all([
    readFile(join(root, "checkout-success.html"), "utf8"),
    readFile(join(root, "checkout-cancelled.html"), "utf8"),
    readFile(join(root, "js/checkout-return.mjs"), "utf8"),
    readFile(join(root, "js/checkout-handoff.js"), "utf8"),
    readFile(join(root, "css/style.css"), "utf8")
  ]);
  assert.match(success, /awaiting secure server verification/i);
  assert.match(success, /does not by itself confirm/i);
  assert.match(success, /data-refresh-status/);
  assert.match(success, /data-recover-checkout/);
  assert.match(success, /js\/checkout-return\.mjs/);
  assert.match(cancelled, /Your cart has been kept/i);
  assert.match(cancelled, /data-refresh-status/);
  assert.match(cancelled, /data-recover-checkout/);
  assert.doesNotMatch(cancelled, /checkout\/sessions|localStorage\.removeItem|mark.*paid/i);
  assert.match(returnScript, /stripe-guest-handoff/);
  assert.match(returnScript, /stripe-guest-status/);
  assert.match(returnScript, /stripe-checkout-recover/);
  assert.match(returnScript, /clearCheckoutAttemptKeys/);
  assert.match(returnScript, /readCheckoutReturnState/);
  assert.match(returnScript, /writeCheckoutReturnState/);
  assert.match(returnScript, /result\.paymentStatus/);
  assert.doesNotMatch(returnScript, /session_id/);
  assert.doesNotMatch(returnScript, /paymentStatus\s*=\s*["']paid/);
  assert.match(handoffScript, /history\.replaceState/);
  assert.match(handoffScript, /sessionStorage/);
  assert.match(handoffScript, /delete\("session_id"\)/);
  assert.match(styles, /\.checkout-return__actions > \[hidden\][\s\S]*?display:\s*none\s*!important/);
  assert.match(returnScript, /delete window\.BEAUTY_PLUZ_CHECKOUT_HANDOFF/);
  assert.ok(success.indexOf("js/checkout-handoff.js") < success.indexOf("fonts.googleapis.com"));
  assert.ok(cancelled.indexOf("js/checkout-handoff.js") < cancelled.indexOf("fonts.googleapis.com"));
});
