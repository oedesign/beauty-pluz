import {
  clearCheckoutAttemptKeys,
  getGuestEndpoint
} from "./stripe-checkout.mjs";
import {
  readCheckoutReturnState,
  writeCheckoutReturnState
} from "./checkout-return-state.mjs";

const checkout = document.querySelector("[data-checkout-return]");

if (checkout) {
  const statusMessage = checkout.querySelector("[data-return-status]");
  const statusDetail = checkout.querySelector("[data-return-detail]");
  const orderReference = checkout.querySelector("[data-order-reference]");
  const refreshButton = checkout.querySelector("[data-refresh-status]");
  const recoverButton = checkout.querySelector("[data-recover-checkout]");
  const isCancelled = checkout.dataset.checkoutReturn === "cancelled";
  const savedState = readCheckoutReturnState();
  const initialHandoff = window.BEAUTY_PLUZ_CHECKOUT_HANDOFF ||
    savedState?.handoffToken;
  delete window.BEAUTY_PLUZ_CHECKOUT_HANDOFF;

  let statusToken = savedState?.statusToken ?? null;
  let recoveryToken = savedState?.recoveryToken ?? null;

  function endpoint(name) {
    try {
      return getGuestEndpoint(window.BEAUTY_PLUZ_BACKEND_CONFIG, name);
    } catch {
      throw new Error("Checkout status is not configured.");
    }
  }

  async function post(name, body) {
    let response;
    try {
      response = await fetch(endpoint(name), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store"
      });
    } catch {
      throw new Error("We could not reach order status. Please try again or contact support.");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Order status could not be confirmed. Please contact support if this continues.");
    }
    if (!response.ok) {
      if (response.status === 429) {
        const retry = Number(response.headers.get("Retry-After"));
        throw new Error(Number.isFinite(retry) && retry > 0
          ? `Please wait ${Math.ceil(retry)} seconds before trying again.`
          : "Please wait before trying again.");
      }
      throw new Error(response.status === 409
        ? "This checkout cannot be resumed safely yet. Please check again later or contact support."
        : "Order status could not be confirmed. Please contact support if this continues.");
    }
    return result;
  }

  function showStatus(result) {
    if (
      !result ||
      !["pending", "paid", "failed"].includes(result.paymentStatus) ||
      typeof result.message !== "string"
    ) {
      throw new Error("Order status returned an unexpected response.");
    }
    statusMessage.textContent = `Payment status: ${result.paymentStatus}.`;
    statusDetail.textContent = result.message;
    if (result.paymentStatus === "paid") {
      clearCheckoutAttemptKeys();
      recoveryToken = null;
      if (statusToken) writeCheckoutReturnState({ statusToken });
    }
    orderReference.textContent = typeof result.orderReference === "string"
      ? `Order reference: ${result.orderReference}`
      : "";
    if (recoverButton) {
      recoverButton.hidden = result.paymentStatus === "paid" ||
        !recoveryToken ||
        (!isCancelled && result.paymentStatus !== "failed");
    }
  }

  async function refreshStatus() {
    if (!statusToken) throw new Error("Secure order status is not available on this page.");
    const result = await post("stripe-guest-status", { statusToken });
    showStatus(result);
  }

  refreshButton?.addEventListener("click", async () => {
    refreshButton.disabled = true;
    statusDetail.textContent = "Checking with our secure order service…";
    try {
      await refreshStatus();
    } catch (error) {
      statusDetail.textContent = error instanceof Error
        ? error.message
        : "Order status could not be confirmed. Please contact support.";
    } finally {
      refreshButton.disabled = false;
    }
  });

  recoverButton?.addEventListener("click", async () => {
    if (!recoveryToken) {
      statusDetail.textContent = "Secure recovery is not available. Please contact support.";
      return;
    }
    recoverButton.disabled = true;
    statusDetail.textContent = "Checking whether this order can be safely resumed…";
    try {
      const result = await post("stripe-checkout-recover", {
        recoveryToken
      });
      const checkoutUrl = new URL(result?.url);
      if (
        checkoutUrl.protocol !== "https:" ||
        checkoutUrl.hostname !== "checkout.stripe.com" ||
        checkoutUrl.username ||
        checkoutUrl.password
      ) {
        throw new Error("Secure checkout returned an invalid link.");
      }
      window.location.assign(checkoutUrl.href);
    } catch (error) {
      statusDetail.textContent = error instanceof Error
        ? error.message
        : "Checkout recovery could not be completed. Please contact support.";
    } finally {
      recoverButton.disabled = false;
    }
  });

  if (!initialHandoff) {
    if (statusToken) {
      statusMessage.textContent = "Payment status: checking with our secure order service…";
      refreshStatus().catch((error) => {
        statusDetail.textContent = error instanceof Error
          ? error.message
          : "Order status could not be confirmed. Please contact support.";
      });
    } else {
      statusMessage.textContent = isCancelled
        ? "Checkout was cancelled."
        : "Payment status: awaiting secure server verification.";
      statusDetail.textContent = "This return link has no secure order-status handoff. The Stripe redirect alone does not confirm payment. Check your email or contact support.";
    }
  } else {
    statusMessage.textContent = isCancelled
      ? "Checkout was cancelled. Checking your order status…"
      : "Payment status: checking with our secure order service…";
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(initialHandoff)) {
        throw new Error("Secure order status is not available on this page.");
      }
      const result = await post("stripe-guest-handoff", { handoffToken: initialHandoff });
      if (
        typeof result.statusToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(result.statusToken)
      ) {
        throw new Error("Order status returned an unexpected response.");
      }
      statusToken = result.statusToken;
      recoveryToken = typeof result.recoveryToken === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(result.recoveryToken)
        ? result.recoveryToken
        : null;
      writeCheckoutReturnState({ statusToken });
      showStatus(result);
    } catch (error) {
      statusDetail.textContent = error instanceof Error
        ? error.message
        : "Order status could not be confirmed. Please contact support.";
    }
  }
}
