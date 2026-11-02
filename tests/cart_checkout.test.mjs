import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const cartSource = await readFile(new URL("../js/cart.js", import.meta.url), "utf8");

class MockElement {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Map();
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.classList = {
      add() {},
      remove() {},
    };
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  async dispatch(type) {
    const callbacks = this.listeners.get(type) || [];
    for (const callback of callbacks) await callback({ target: this });
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  querySelector(selector) {
    if (!this.childrenBySelector) this.childrenBySelector = new Map();
    if (!this.childrenBySelector.has(selector)) {
      this.childrenBySelector.set(selector, new MockElement());
    }
    return this.childrenBySelector.get(selector);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  focus() {
    this.focused = true;
  }
}

function createCartHarness({ fetchImpl, sessionValues = new Map() } = {}) {
  const selectors = [
    "[data-cart-list]",
    "[data-cart-empty]",
    "[data-cart-layout]",
    "[data-cart-summary-totals]",
    "[data-order-whatsapp]",
    "[data-checkout-sumup]",
    "[data-delivery-error]",
    "#customer-name",
    "#customer-phone",
    "#customer-address",
    "#customer-country",
    "#customer-postal-code",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new MockElement()]));
  const documentListeners = new Map();
  const cartValue = JSON.stringify([
    { id: "product-one", name: "Product", price: 99, quantity: 2 },
    { id: "product-two", name: "Another product", price: 1, quantity: 1 },
  ]);
  const localValues = new Map([["beautyPluzCart", cartValue]]);
  const redirects = [];
  const calls = [];
  const products = new Map([
    ["product-one", { id: "product-one", name: "Product", price: 10, sale_price: null, image: "", category: "", is_available: true, stock_quantity: null }],
    ["product-two", { id: "product-two", name: "Another product", price: 5, sale_price: null, image: "", category: "", is_available: true, stock_quantity: null }],
  ]);

  elements.get("#customer-name").value = "Sample Customer";
  elements.get("#customer-phone").value = "+441234567890";
  elements.get("#customer-address").value = "1 Checkout Street";
  elements.get("#customer-country").value = "gb";
  elements.get("#customer-postal-code").value = "SW1A 1AA";

  const document = {
    addEventListener(type, callback) {
      const callbacks = documentListeners.get(type) || [];
      callbacks.push(callback);
      documentListeners.set(type, callbacks);
    },
    querySelector(selector) {
      return elements.get(selector) || null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return new MockElement();
    },
    createDocumentFragment() {
      return new MockElement();
    },
  };
  const window = {
    BEAUTY_PLUZ_BACKEND_CONFIG: {
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "public-test-key",
    },
    BeautyPluzProducts: {
      ready: Promise.resolve(),
      getById: (id) => products.get(id),
    },
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    location: {
      assign: (url) => redirects.push(url),
    },
    setTimeout,
    sessionStorage: {
      getItem: (key) => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
      removeItem: (key) => sessionValues.delete(key),
    },
  };
  const context = createContext({
    window,
    document,
    URL,
    TextEncoder,
    Uint8Array,
    Promise,
    JSON,
    console,
    setTimeout,
    localStorage: {
      getItem: (key) => localValues.get(key) ?? null,
      setItem: (key, value) => localValues.set(key, value),
    },
    fetch: async (...args) => {
      calls.push(args);
      if (!fetchImpl) throw new Error("No fetch mock configured");
      return await fetchImpl(...args);
    },
  });

  runInContext(cartSource, context);
  for (const callback of documentListeners.get("DOMContentLoaded") || []) {
    callback();
  }

  return {
    calls,
    elements,
    localValues,
    redirects,
    sessionValues,
    async ready() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    getCheckoutButton() {
      return elements.get("[data-checkout-sumup]");
    },
    getCheckoutLabel() {
      return elements.get("[data-checkout-sumup]").querySelector("[data-checkout-label]");
    },
    getError() {
      return elements.get("[data-delivery-error]");
    },
    setFetch(implementation) {
      fetchImpl = implementation;
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const successBody = {
  orderId: "86a89065-c53f-4e6f-a5e5-2dce0addab2b",
  hostedCheckoutUrl: "https://checkout.sumup.com/pay/test-checkout",
  paymentStatus: "pending",
};

test("submits only product IDs and quantities with required details and redirects", async () => {
  const harness = createCartHarness({
    fetchImpl: async () => jsonResponse(201, successBody),
  });
  const originalCart = harness.localValues.get("beautyPluzCart");
  await harness.ready();

  await harness.getCheckoutButton().dispatch("click");

  assert.equal(harness.calls.length, 1);
  const [url, options] = harness.calls[0];
  assert.equal(url, "https://example.supabase.co/functions/v1/create-checkout-order");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.apikey, "public-test-key");
  assert.equal(options.headers.Authorization, "Bearer public-test-key");
  assert.equal(options.headers["Content-Type"], "application/json");
  const body = JSON.parse(options.body);
  assert.deepEqual(body.items, [
    { id: "product-one", quantity: 2 },
    { id: "product-two", quantity: 1 },
  ]);
  assert.equal(body.customerName, "Sample Customer");
  assert.equal(body.customerPhone, "+441234567890");
  assert.equal(body.shippingAddress, "1 Checkout Street");
  assert.equal(body.countryCode, "GB");
  assert.equal(body.postalCode, "SW1A1AA");
  assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/i);
  assert.match(body.checkoutAccessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal("price" in body.items[0], false);
  assert.deepEqual(harness.redirects, [successBody.hostedCheckoutUrl]);
  assert.equal(harness.localValues.get("beautyPluzCart"), originalCart);
});

test("missing required customer or delivery fields prevent submission", async (t) => {
  const cases = [
    ["#customer-name", /name/i],
    ["#customer-phone", /phone/i],
    ["#customer-address", /address/i],
    ["#customer-country", /country code/i],
    ["#customer-postal-code", /postal code/i],
  ];
  for (const [selector, expectedMessage] of cases) {
    await t.test(selector, async () => {
      const harness = createCartHarness({
        fetchImpl: async () => jsonResponse(201, successBody),
      });
      await harness.ready();
      harness.elements.get(selector).value = "";

      await harness.getCheckoutButton().dispatch("click");

      assert.equal(harness.calls.length, 0);
      assert.equal(harness.getError().hidden, false);
      assert.match(harness.getError().textContent, expectedMessage);
      assert.equal(harness.elements.get(selector).focused, true);
    });
  }
});

test("rejects untrusted or malformed hosted checkout URLs", async (t) => {
  const badUrls = [
    null,
    "http://checkout.sumup.com/pay/test-checkout",
    "https://evil.example/pay/test-checkout",
    "https://checkout.sumup.com.evil.example/pay/test-checkout",
    "https://checkout.sumup.com:444/pay/test-checkout",
    "https://checkout.sumup.com/pay/test-checkout?next=https://evil.example",
    "https://checkout.sumup.com/pay/",
  ];
  for (const url of badUrls) {
    await t.test(url ? url.split("/")[2] : "missing URL", async () => {
      const harness = createCartHarness({
        fetchImpl: async () => jsonResponse(201, {
          ...successBody,
          hostedCheckoutUrl: url,
        }),
      });
      await harness.ready();

      await harness.getCheckoutButton().dispatch("click");

      assert.deepEqual(harness.redirects, []);
      assert.match(harness.getError().textContent, /couldn't verify/i);
    });
  }
});

test("displays backend errors without clearing the cart", async () => {
  const harness = createCartHarness({
    fetchImpl: async () => jsonResponse(409, {
      error: "One or more items are unavailable or have insufficient stock.",
    }),
  });
  const originalCart = harness.localValues.get("beautyPluzCart");
  await harness.ready();

  await harness.getCheckoutButton().dispatch("click");

  assert.equal(harness.getError().textContent, "One or more items are unavailable or have insufficient stock.");
  assert.equal(harness.localValues.get("beautyPluzCart"), originalCart);
  assert.deepEqual(harness.redirects, []);
});

test("warns before retrying a checkout the backend cannot resume", async () => {
  const requestBodies = [];
  const harness = createCartHarness({
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return jsonResponse(409, {
        error: "This checkout request cannot be reused. Please start checkout again.",
      });
    },
  });
  const originalCart = harness.localValues.get("beautyPluzCart");
  await harness.ready();

  await harness.getCheckoutButton().dispatch("click");
  await harness.getCheckoutButton().dispatch("click");

  assert.equal(requestBodies[0].idempotencyKey, requestBodies[1].idempotencyKey);
  assert.match(harness.getError().textContent, /contact us before trying again/i);
  assert.equal(harness.localValues.get("beautyPluzCart"), originalCart);
});

test("handles network failures and preserves the cart", async () => {
  const harness = createCartHarness({
    fetchImpl: async () => {
      throw new Error("network failure");
    },
  });
  const originalCart = harness.localValues.get("beautyPluzCart");
  await harness.ready();

  await harness.getCheckoutButton().dispatch("click");

  assert.match(harness.getError().textContent, /couldn't reach secure checkout/i);
  assert.equal(harness.localValues.get("beautyPluzCart"), originalCart);
  assert.deepEqual(harness.redirects, []);
});

test("does not submit duplicate requests while a checkout is in flight", async () => {
  let resolveFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  const harness = createCartHarness({
    fetchImpl: () => {
      markFetchStarted();
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });
  await harness.ready();

  const firstClick = harness.getCheckoutButton().dispatch("click");
  await fetchStarted;
  await harness.getCheckoutButton().dispatch("click");

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.getCheckoutButton().disabled, true);
  assert.match(harness.getCheckoutLabel().textContent, /preparing/i);
  resolveFetch(jsonResponse(201, successBody));
  await firstClick;
  assert.deepEqual(harness.redirects, [successBody.hostedCheckoutUrl]);
});

test("reuses the idempotency key and checkout token when retrying the same request", async () => {
  const sessionValues = new Map();
  const first = createCartHarness({
    sessionValues,
    fetchImpl: async () => {
      throw new Error("network failure");
    },
  });
  await first.ready();
  await first.getCheckoutButton().dispatch("click");
  const firstBody = JSON.parse(first.calls[0][1].body);

  const retry = createCartHarness({
    sessionValues,
    fetchImpl: async () => jsonResponse(201, successBody),
  });
  await retry.ready();
  await retry.getCheckoutButton().dispatch("click");
  const retryBody = JSON.parse(retry.calls[0][1].body);

  assert.equal(retryBody.idempotencyKey, firstBody.idempotencyKey);
  assert.equal(retryBody.checkoutAccessToken, firstBody.checkoutAccessToken);
});

test("a pending creation response asks the customer to retry without redirecting", async () => {
  const harness = createCartHarness({
    fetchImpl: async () => jsonResponse(202, {
      orderId: successBody.orderId,
      paymentStatus: "pending",
    }),
  });
  await harness.ready();

  await harness.getCheckoutButton().dispatch("click");

  assert.match(harness.getError().textContent, /still being prepared/i);
  assert.deepEqual(harness.redirects, []);
  assert.equal(harness.getCheckoutButton().disabled, false);
});

test("a verified expired checkout releases its idempotency attempt for a new checkout", async () => {
  const requestBodies = [];
  const harness = createCartHarness({
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return requestBodies.length === 1
        ? jsonResponse(201, { ...successBody, paymentStatus: "expired" })
        : jsonResponse(201, successBody);
    },
  });
  await harness.ready();

  await harness.getCheckoutButton().dispatch("click");
  await harness.getCheckoutButton().dispatch("click");

  assert.match(harness.getError().textContent, /checkout has expired/i);
  assert.notEqual(requestBodies[0].idempotencyKey, requestBodies[1].idempotencyKey);
  assert.deepEqual(harness.redirects, [successBody.hostedCheckoutUrl]);
});
