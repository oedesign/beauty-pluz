import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../js/payment-result.js", import.meta.url), "utf8");
const orderId = "86a89065-c53f-4e6f-a5e5-2dce0addab2b";
const checkoutAccessToken = "A".repeat(43);
const checkoutItems = [
  { id: "product-one", quantity: 2 },
  { id: "product-two", quantity: 1 },
];
const checkoutAttempt = {
  orderId,
  checkoutAccessToken,
  items: checkoutItems,
  paymentStatus: "pending",
};

class MockElement {
  constructor() {
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    this.listeners.set(type, callback);
  }

  async dispatch(type) {
    await this.listeners.get(type)?.();
  }
}

function createHarness({
  fetchImpl,
  storedAttempt = checkoutAttempt,
  cartItems = [
    { id: "product-one", quantity: 2 },
    { id: "product-two", quantity: 1 },
  ],
  search = "?paymentStatus=paid",
} = {}) {
  const selectors = [
    "[data-result-card]",
    "[data-result-icon]",
    "[data-result-heading]",
    "[data-result-message]",
    "[data-result-reference]",
    "[data-verify-again]",
    "[data-result-shop]",
    "[data-result-contact]",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new MockElement()]));
  const documentListeners = new Map();
  const sessionValues = new Map([
    ["beautyPluzSumUpCheckoutAttempt", JSON.stringify(storedAttempt)],
  ]);
  const localValues = new Map([
    ["beautyPluzCart", JSON.stringify(cartItems)],
  ]);
  const calls = [];
  let clearCount = 0;
  const document = {
    addEventListener(type, callback) {
      documentListeners.set(type, callback);
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    },
  };
  const crypto = {
    subtle: {
      async digest() {
        return Uint8Array.from({ length: 32 }, (_, index) => index).buffer;
      },
    },
  };
  const window = {
    BEAUTY_PLUZ_BACKEND_CONFIG: {
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "public-test-key",
    },
    BeautyPluzCart: {
      clear() {
        clearCount += 1;
        localValues.set("beautyPluzCart", "[]");
      },
    },
    crypto,
    location: { search },
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
    },
    localStorage: {
      getItem: (key) => localValues.get(key) ?? null,
    },
  };
  const context = createContext({
    window,
    document,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    URL,
    JSON,
    Promise,
    fetch: async (...args) => {
      calls.push(args);
      if (!fetchImpl) throw new Error("No fetch mock configured");
      return await fetchImpl(...args);
    },
  });
  runInContext(source, context);
  documentListeners.get("DOMContentLoaded")();

  return {
    calls,
    elements,
    localValues,
    sessionValues,
    get clearCount() {
      return clearCount;
    },
    async settle() {
      for (let index = 0; index < 8; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

test("sends the private checkout context to the verification function", async () => {
  const harness = createHarness({
    fetchImpl: async () => response(200, { paymentStatus: "pending" }),
  });
  await harness.settle();

  assert.equal(harness.calls.length, 1);
  const [url, options] = harness.calls[0];
  assert.equal(url, "https://example.supabase.co/functions/v1/verify-sumup-payment");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.apikey, "public-test-key");
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(options.body), { orderId, checkoutAccessToken });
  assert.equal(harness.elements.get("[data-result-card]").dataset.state, "pending");
  assert.equal(harness.clearCount, 0);
});

test("only a backend-verified paid response clears an unchanged cart", async () => {
  const harness = createHarness({
    fetchImpl: async () => response(200, { paymentStatus: "paid" }),
  });
  await harness.settle();

  assert.equal(harness.elements.get("[data-result-card]").dataset.state, "paid");
  assert.equal(harness.clearCount, 1);
  assert.equal(harness.localValues.get("beautyPluzCart"), "[]");
  const reference = harness.elements.get("[data-result-reference]");
  assert.equal(reference.hidden, false);
  assert.match(reference.textContent, /^Confirmation reference: BP-[0-9A-F]{8}$/);
  assert.equal(reference.textContent.includes(orderId), false);
});

test("preserves a cart changed since checkout even after payment is verified", async () => {
  const currentCart = [{ id: "different-product", quantity: 1 }];
  const harness = createHarness({
    cartItems: currentCart,
    fetchImpl: async () => response(200, { paymentStatus: "paid" }),
  });
  await harness.settle();

  assert.equal(harness.clearCount, 0);
  assert.equal(harness.localValues.get("beautyPluzCart"), JSON.stringify(currentCart));
});

test("renders all authoritative payment states without trusting URL or saved status", async (t) => {
  const cases = [
    ["pending", "pending", true],
    ["failed", "failed", false],
    ["cancelled", "cancelled", false],
    ["expired", "expired", false],
    ["paid", "pending", false],
  ];
  for (const [serverStatus, storedStatus, expectsRetry] of cases) {
    await t.test(serverStatus, async () => {
      const harness = createHarness({
        storedAttempt: { ...checkoutAttempt, paymentStatus: storedStatus },
        search: "?paymentStatus=paid&status=SUCCESS",
        fetchImpl: async () => response(200, { paymentStatus: serverStatus }),
      });
      await harness.settle();

      assert.equal(harness.elements.get("[data-result-card]").dataset.state, serverStatus);
      assert.equal(harness.elements.get("[data-verify-again]").hidden, !expectsRetry);
      assert.equal(harness.clearCount, serverStatus === "paid" ? 1 : 0);
    });
  }
});

test("offers an explicit recheck and verifies again after a return-page refresh", async () => {
  const sessionValues = new Map([
    ["beautyPluzSumUpCheckoutAttempt", JSON.stringify(checkoutAttempt)],
  ]);
  const first = createHarness({
    storedAttempt: JSON.parse(sessionValues.get("beautyPluzSumUpCheckoutAttempt")),
    fetchImpl: async () => response(200, { paymentStatus: "pending" }),
  });
  await first.settle();
  assert.equal(first.elements.get("[data-verify-again]").hidden, false);
  await first.elements.get("[data-verify-again]").dispatch("click");
  await first.settle();
  assert.equal(first.calls.length, 2);

  const second = createHarness({
    storedAttempt: JSON.parse(sessionValues.get("beautyPluzSumUpCheckoutAttempt")),
    fetchImpl: async () => response(200, { paymentStatus: "paid" }),
  });
  await second.settle();
  assert.equal(second.calls.length, 1);
  assert.equal(second.clearCount, 1);
});

test("does not submit when checkout context is missing or malformed", async (t) => {
  const cases = [
    ["missing", null],
    ["invalid order id", { ...checkoutAttempt, orderId: "not-an-id" }],
    ["invalid access token", { ...checkoutAttempt, checkoutAccessToken: "invalid" }],
    ["invalid item list", { ...checkoutAttempt, items: [] }],
  ];
  for (const [name, storedAttempt] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({
        storedAttempt,
        fetchImpl: async () => response(200, { paymentStatus: "paid" }),
      });
      await harness.settle();

      assert.equal(harness.calls.length, 0);
      assert.equal(harness.elements.get("[data-result-card]").dataset.state, "unavailable");
      assert.equal(harness.clearCount, 0);
    });
  }
});

test("handles inaccessible checkouts, server errors, malformed statuses, and network failures", async (t) => {
  const cases = [
    ["inaccessible checkout", async () => response(404, { error: "unavailable" }), "unavailable"],
    ["server error", async () => response(503, { error: "unavailable" }), "error"],
    ["unexpected status", async () => response(200, { paymentStatus: "success" }), "error"],
    ["network failure", async () => { throw new Error("offline"); }, "error"],
  ];
  for (const [name, fetchImpl, expectedState] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({ fetchImpl });
      await harness.settle();

      assert.equal(harness.elements.get("[data-result-card]").dataset.state, expectedState);
      assert.equal(harness.clearCount, 0);
    });
  }
});

test("prevents concurrent verification requests from repeated clicks", async () => {
  let resolveResponse;
  const harness = createHarness({
    fetchImpl: () => new Promise((resolve) => {
      resolveResponse = resolve;
    }),
  });
  await harness.settle();
  const retryClick = harness.elements.get("[data-verify-again]").dispatch("click");
  await harness.settle();

  assert.equal(harness.calls.length, 1);
  resolveResponse(response(200, { paymentStatus: "pending" }));
  await retryClick;
  await harness.settle();
  assert.equal(harness.calls.length, 1);
});
