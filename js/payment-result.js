(function () {
  "use strict";

  const CHECKOUT_ATTEMPT_STORAGE_KEY = "beautyPluzSumUpCheckoutAttempt";
  const CART_STORAGE_KEY = "beautyPluzCart";
  const orderIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const accessTokenPattern = /^[A-Za-z0-9_-]{43}$/;
  const paymentStatuses = new Set([
    "paid",
    "pending",
    "failed",
    "cancelled",
    "expired",
  ]);
  let verifying = false;
  let checkoutContext = null;

  const states = {
    checking: {
      icon: "…",
      heading: "Checking your payment",
      message: "Please wait while we confirm your payment securely.",
      retry: false,
      shop: false,
      contact: false,
    },
    paid: {
      icon: "✓",
      heading: "Payment verified",
      message: "Your payment has been confirmed securely. Thank you for shopping with Beauty Pluz. We’ll prepare your order and contact you with any delivery updates.",
      retry: false,
      shop: true,
      contact: false,
    },
    pending: {
      icon: "…",
      heading: "Payment is still being confirmed",
      message: "We haven’t received a final confirmation yet. You can check again shortly; this does not mean your payment failed.",
      retry: true,
      shop: true,
      contact: false,
    },
    failed: {
      icon: "!",
      heading: "Payment not confirmed",
      message: "SumUp has confirmed that this payment was not successful. You can return to your cart to start a new checkout.",
      retry: false,
      shop: true,
      contact: false,
    },
    cancelled: {
      icon: "!",
      heading: "Checkout cancelled",
      message: "This checkout is no longer active. You can return to your cart to start a new checkout.",
      retry: false,
      shop: true,
      contact: false,
    },
    expired: {
      icon: "!",
      heading: "Payment session expired",
      message: "This payment session has expired and can no longer be used. Your cart is available if you’d like to start a new checkout.",
      retry: false,
      shop: true,
      contact: false,
    },
    unavailable: {
      icon: "!",
      heading: "Payment details unavailable",
      message: "We couldn’t verify this checkout with the information available in this browser. This does not confirm whether payment succeeded. Please contact us before trying to pay again.",
      retry: false,
      shop: false,
      contact: true,
    },
    error: {
      icon: "!",
      heading: "We couldn’t confirm your payment",
      message: "Payment confirmation is temporarily unavailable. Your payment status is not known yet; please try again shortly.",
      retry: true,
      shop: false,
      contact: true,
    },
  };

  function getElements() {
    return {
      card: document.querySelector("[data-result-card]"),
      icon: document.querySelector("[data-result-icon]"),
      heading: document.querySelector("[data-result-heading]"),
      message: document.querySelector("[data-result-message]"),
      reference: document.querySelector("[data-result-reference]"),
      retry: document.querySelector("[data-verify-again]"),
      shop: document.querySelector("[data-result-shop]"),
      contact: document.querySelector("[data-result-contact]"),
    };
  }

  function renderState(name, busy) {
    const state = states[name] || states.error;
    const elements = getElements();
    if (elements.card) elements.card.dataset.state = name;
    if (elements.icon) elements.icon.textContent = state.icon;
    if (elements.heading) elements.heading.textContent = state.heading;
    if (elements.message) elements.message.textContent = state.message;
    if (elements.retry) {
      elements.retry.hidden = !state.retry;
      elements.retry.disabled = busy;
      elements.retry.textContent = busy ? "Checking…" : "Check payment status";
    }
    if (elements.shop) elements.shop.hidden = !state.shop;
    if (elements.contact) elements.contact.hidden = !state.contact;
  }

  function readCheckoutContext() {
    let context;
    try {
      context = JSON.parse(
        window.sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) || "null",
      );
    } catch {
      return null;
    }
    if (
      !context ||
      typeof context !== "object" ||
      !orderIdPattern.test(context.orderId) ||
      !accessTokenPattern.test(context.checkoutAccessToken) ||
      !Array.isArray(context.items) ||
      context.items.length < 1 ||
      !context.items.every((item) =>
        item &&
        typeof item.id === "string" &&
        Number.isInteger(item.quantity) &&
        item.quantity > 0
      )
    ) return null;
    return context;
  }

  function getVerificationEndpoint() {
    const config = window.BEAUTY_PLUZ_BACKEND_CONFIG;
    if (
      !config ||
      typeof config.supabaseUrl !== "string" ||
      typeof config.supabaseAnonKey !== "string" ||
      !config.supabaseAnonKey
    ) throw new Error("Payment verification is unavailable.");

    let backendUrl;
    try {
      backendUrl = new URL(config.supabaseUrl);
    } catch {
      throw new Error("Payment verification is unavailable.");
    }
    if (
      backendUrl.protocol !== "https:" ||
      backendUrl.username ||
      backendUrl.password ||
      backendUrl.search ||
      backendUrl.hash
    ) throw new Error("Payment verification is unavailable.");

    return {
      url: new URL("/functions/v1/verify-sumup-payment", backendUrl.origin).href,
      anonKey: config.supabaseAnonKey,
    };
  }

  function saveVerifiedStatus(status) {
    try {
      const current = JSON.parse(
        window.sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) || "null",
      );
      if (
        !current ||
        current.orderId !== checkoutContext.orderId ||
        current.checkoutAccessToken !== checkoutContext.checkoutAccessToken
      ) return false;
      current.paymentStatus = status;
      window.sessionStorage.setItem(
        CHECKOUT_ATTEMPT_STORAGE_KEY,
        JSON.stringify(current),
      );
      checkoutContext = current;
      return true;
    } catch {
      return false;
    }
  }

  function sameCartAsCheckout(items) {
    try {
      const current = JSON.parse(
        window.localStorage.getItem(CART_STORAGE_KEY) || "[]",
      );
      if (!Array.isArray(current) || current.length !== items.length) return false;
      const normalizedCurrent = current
        .map((item) => ({ id: item.id, quantity: item.quantity }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const normalizedCheckout = items
        .map((item) => ({ id: item.id, quantity: item.quantity }))
        .sort((left, right) => left.id.localeCompare(right.id));
      return normalizedCurrent.every((item, index) =>
        item.id === normalizedCheckout[index].id &&
        item.quantity === normalizedCheckout[index].quantity
      );
    } catch {
      return false;
    }
  }

  async function displayOrderReference(orderId) {
    const element = getElements().reference;
    if (!element) return;
    try {
      const digest = await window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(orderId),
      );
      const reference = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("").slice(0, 8).toUpperCase();
      element.textContent = `Confirmation reference: BP-${reference}`;
      element.hidden = false;
    } catch {
      element.hidden = true;
    }
  }

  async function verifyPayment() {
    if (verifying || !checkoutContext) return;
    verifying = true;
    renderState("checking", true);
    const reference = getElements().reference;
    if (reference) reference.hidden = true;

    try {
      const endpoint = getVerificationEndpoint();
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          apikey: endpoint.anonKey,
          Authorization: `Bearer ${endpoint.anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId: checkoutContext.orderId,
          checkoutAccessToken: checkoutContext.checkoutAccessToken,
        }),
      });

      let result;
      try {
        result = await response.json();
      } catch {
        renderState("error", false);
        return;
      }

      if (response.status === 404) {
        renderState("unavailable", false);
        return;
      }
      if (!response.ok) {
        renderState("error", false);
        return;
      }
      if (
        !result ||
        typeof result.paymentStatus !== "string" ||
        !paymentStatuses.has(result.paymentStatus)
      ) {
        renderState("error", false);
        return;
      }

      const status = result.paymentStatus;
      saveVerifiedStatus(status);
      renderState(status, false);
      if (status === "paid") {
        await displayOrderReference(checkoutContext.orderId);
        if (
          sameCartAsCheckout(checkoutContext.items) &&
          window.BeautyPluzCart &&
          typeof window.BeautyPluzCart.clear === "function"
        ) {
          window.BeautyPluzCart.clear();
        }
      }
    } catch {
      renderState("error", false);
    } finally {
      verifying = false;
      const retry = getElements().retry;
      if (retry && !retry.hidden) retry.disabled = false;
    }
  }

  function initPaymentResult() {
    const retry = getElements().retry;
    if (retry) {
      retry.addEventListener("click", () => {
        void verifyPayment();
      });
    }

    checkoutContext = readCheckoutContext();
    if (!checkoutContext) {
      renderState("unavailable", false);
      return;
    }
    renderState("checking", false);
    void verifyPayment();
  }

  document.addEventListener("DOMContentLoaded", initPaymentResult);
})();
