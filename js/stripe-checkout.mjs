const GUEST_FUNCTIONS = new Set([
  "stripe-checkout",
  "stripe-checkout-recover",
  "stripe-guest-handoff",
  "stripe-guest-status"
]);
const CHECKOUT_ATTEMPT_PREFIX = "beautyPluzStripeCheckout:";
const CHECKOUT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const inMemoryAttempts = new Map();

export class CheckoutClientError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "CheckoutClientError";
    this.status = status;
  }
}

export function createSingleFlight(action) {
  let running = false;
  return async (...args) => {
    if (running) return undefined;
    running = true;
    try {
      return await action(...args);
    } finally {
      running = false;
    }
  };
}

export function buildCheckoutRequest(items, customer, idempotencyKey = null) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    throw new CheckoutClientError("Your cart is empty or too large.");
  }
  if (idempotencyKey !== null &&
      (typeof idempotencyKey !== "string" || !CHECKOUT_ID_PATTERN.test(idempotencyKey))) {
    throw new CheckoutClientError("Secure checkout is not available right now.");
  }

  const seenProductIds = new Set();
  const normalizedItems = items.map((item) => {
    const productId = typeof item?.id === "string" ? item.id.trim() : "";
    const quantity = item && typeof item === "object" ? item.quantity : null;
    if (
      productId.length < 1 ||
      productId.length > 180 ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 100 ||
      seenProductIds.has(productId)
    ) {
      throw new CheckoutClientError("A cart item is invalid. Please review your cart.");
    }
    seenProductIds.add(productId);
    return { productId, quantity };
  });

  const name = typeof customer?.name === "string" ? customer.name.trim() : "";
  const email = typeof customer?.email === "string" ? customer.email.trim().toLowerCase() : "";
  const phone = typeof customer?.phone === "string" ? customer.phone.trim() : "";
  const shippingAddress = typeof customer?.shippingAddress === "string"
    ? customer.shippingAddress.trim()
    : "";
  if (
    name.length < 1 ||
    name.length > 180 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (phone && (phone.length > 40 || !/^[+0-9().\-\s]{7,40}$/.test(phone))) ||
    shippingAddress.length < 5 ||
    shippingAddress.length > 1000
  ) {
    throw new CheckoutClientError("Please enter valid contact and delivery details.");
  }

  const payload = {
    customer: {
      name,
      email,
      phone: phone || null,
      shippingAddress
    },
    items: normalizedItems
  };
  if (idempotencyKey !== null) payload.idempotencyKey = idempotencyKey;
  return payload;
}

export function getCheckoutEndpoint(config) {
  return getGuestEndpoint(config, "stripe-checkout");
}

export function getGuestEndpoint(config, functionName) {
  const baseUrl = typeof config?.guestCheckoutGatewayUrl === "string"
    ? config.guestCheckoutGatewayUrl.trim()
    : "";
  if (!baseUrl) {
    throw new CheckoutClientError("Secure checkout is not configured yet. Please contact us.");
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CheckoutClientError("Secure checkout is not configured yet. Please contact us.");
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    !GUEST_FUNCTIONS.has(functionName)
  ) {
    throw new CheckoutClientError("Secure checkout is not configured yet. Please contact us.");
  }
  return `${url.origin}/${functionName}`;
}

async function checkoutFingerprint(payload, cryptoApi) {
  if (!cryptoApi?.subtle || typeof TextEncoder === "undefined") {
    throw new CheckoutClientError("Secure checkout is not available in this browser.");
  }
  const normalized = JSON.stringify({
    customer: payload.customer,
    items: [...payload.items].sort((a, b) => a.productId.localeCompare(b.productId))
  });
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createIdempotencyKey(cryptoApi) {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new CheckoutClientError("Secure checkout is not available in this browser.");
  }
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function getOrCreateIdempotencyKey(payload, options = {}) {
  const cryptoApi = options.crypto ?? globalThis.crypto;
  let storage = options.storage;
  if (options.storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = undefined;
    }
  }
  const fingerprint = await checkoutFingerprint(payload, cryptoApi);
  const storageKey = `${CHECKOUT_ATTEMPT_PREFIX}${fingerprint}`;

  try {
    const existing = storage ? storage.getItem(storageKey) : inMemoryAttempts.get(storageKey);
    if (existing && CHECKOUT_ID_PATTERN.test(existing)) return existing;
  } catch {
    const existing = inMemoryAttempts.get(storageKey);
    if (existing) return existing;
  }

  const idempotencyKey = createIdempotencyKey(cryptoApi);
  if (!storage) {
    inMemoryAttempts.set(storageKey, idempotencyKey);
    return idempotencyKey;
  }
  try {
    storage.setItem(storageKey, idempotencyKey);
  } catch {
    inMemoryAttempts.set(storageKey, idempotencyKey);
  }
  return idempotencyKey;
}

export function clearCheckoutAttemptKeys(storage) {
  inMemoryAttempts.clear();
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch {
      return;
    }
  }
  if (!storage) return;
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(CHECKOUT_ATTEMPT_PREFIX)) storage.removeItem(key);
    }
  } catch {
    return;
  }
}

export async function requestStripeCheckout(endpoint, payload, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
  } catch {
    throw new CheckoutClientError("We couldn't reach secure checkout. Check your connection and try again.");
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new CheckoutClientError("Secure checkout returned an unexpected response.", response.status);
  }
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      throw new CheckoutClientError(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? `Too many checkout attempts. Please wait ${Math.ceil(retryAfter)} seconds and try again.`
          : "Too many checkout attempts. Please wait and try again.",
        response.status
      );
    }
    throw new CheckoutClientError("Secure checkout could not be started. Please try again.", response.status);
  }
  if (result === null || typeof result !== "object" || typeof result.url !== "string") {
    throw new CheckoutClientError("Secure checkout returned an unexpected response.", response.status);
  }

  let checkoutUrl;
  try {
    checkoutUrl = new URL(result.url);
  } catch {
    throw new CheckoutClientError("Secure checkout returned an invalid link.", response.status);
  }
  if (
    checkoutUrl.protocol !== "https:" ||
    checkoutUrl.hostname !== "checkout.stripe.com" ||
    checkoutUrl.username ||
    checkoutUrl.password
  ) {
    throw new CheckoutClientError("Secure checkout returned an invalid link.", response.status);
  }
  return checkoutUrl.href;
}
