/* =========================================================
   BEAUTY PLUZ — CART.JS
   Shopping cart state, persisted to localStorage so it
   survives across index/shop/cart/contact page loads.
   Cart state, cart-page rendering, WhatsApp ordering, and
   SumUp checkout integration.
   ========================================================= */

(function () {
  "use strict";

  const STORAGE_KEY = "beautyPluzCart";
  const CHECKOUT_ATTEMPT_STORAGE_KEY = "beautyPluzSumUpCheckoutAttempt";
  const DELIVERY_FEE = 4.60;
  const checkoutIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const checkoutTokenPattern = /^[A-Za-z0-9_-]{43}$/;
  let checkoutSubmitting = false;

  function currentPrice(product) {
    return product.sale_price === null || product.sale_price === undefined
      ? product.price
      : product.sale_price;
  }

  /**
   * Cart item shape:
   * { id, name, price, image, quantity }
   */
  const Cart = {
    _listeners: [],

    getItems() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const items = raw ? JSON.parse(raw) : [];
        // Product ids are authoritative: refresh persisted cart display data
        // from the local catalogue so old/stale image URLs cannot be mixed in.
        return Array.isArray(items) ? items.flatMap((item) => {
          const product = window.BeautyPluzProducts?.getById(item.id);
          if (!product || !product.is_available || product.stock_quantity === 0) return [];
          const quantity = product.stock_quantity === null
            ? item.quantity
            : Math.min(item.quantity, product.stock_quantity);
          return quantity > 0 ? [{
            ...item,
            quantity,
            name: product.name,
            price: currentPrice(product),
            image: product.image,
            icon: product.icon,
            category: product.category,
            sale_price: product.sale_price,
            is_available: product.is_available,
            stock_quantity: product.stock_quantity,
          }] : [];
        }) : [];
      } catch (err) {
        console.error("Beauty Pluz: could not read cart from storage", err);
        return [];
      }
    },

    _save(items) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      } catch (err) {
        console.error("Beauty Pluz: could not save cart to storage", err);
      }
      this._emit(items);
    },

    addItem(product, quantity) {
      if (!product.is_available || product.stock_quantity === 0) return this.getItems();
      const requestedQty = quantity && quantity > 0 ? quantity : 1;
      const items = this.getItems();
      const existing = items.find((item) => item.id === product.id);
      const currentQuantity = existing ? existing.quantity : 0;
      const availableQty = product.stock_quantity === null
        ? requestedQty
        : Math.min(requestedQty, Math.max(product.stock_quantity - currentQuantity, 0));
      if (availableQty === 0) return items;

      if (existing) {
        existing.quantity += availableQty;
      } else {
        items.push({
          id: product.id,
          name: product.name,
          price: currentPrice(product),
          sale_price: product.sale_price,
          image: product.image || "",
          icon: product.icon || "",
          category: product.category || "",
          quantity: availableQty,
        });
      }

      this._save(items);
      return items;
    },

    updateQuantity(id, quantity) {
      let items = this.getItems();
      if (quantity <= 0) {
        items = items.filter((item) => item.id !== id);
      } else {
        const target = items.find((item) => item.id === id);
        const product = window.BeautyPluzProducts?.getById(id);
        if (target) {
          target.quantity = product?.stock_quantity === null || product?.stock_quantity === undefined
            ? quantity
            : Math.min(quantity, product.stock_quantity);
          if (target.quantity === 0) items = items.filter((item) => item.id !== id);
        }
      }
      this._save(items);
      return items;
    },

    /** Convenience wrappers around updateQuantity for +/- stepper controls */
    incrementItem(id) {
      const item = this.getItems().find((entry) => entry.id === id);
      if (!item) return this.getItems();
      return this.updateQuantity(id, item.quantity + 1);
    },

    decrementItem(id) {
      const item = this.getItems().find((entry) => entry.id === id);
      if (!item) return this.getItems();
      return this.updateQuantity(id, item.quantity - 1);
    },

    removeItem(id) {
      const items = this.getItems().filter((item) => item.id !== id);
      this._save(items);
      return items;
    },

    clear() {
      this._save([]);
    },

    getItemCount() {
      return this.getItems().reduce((total, item) => total + item.quantity, 0);
    },

    getSubtotal() {
      return this.getItems().reduce(
        (total, item) => total + item.price * item.quantity,
        0
      );
    },

    /** Subscribe to cart changes, e.g. to refresh a header badge */
    onChange(callback) {
      if (typeof callback === "function") this._listeners.push(callback);
    },

    _emit(items) {
      this._listeners.forEach((callback) => callback(items));
    },
  };

  window.BeautyPluzCart = Cart;

  /* -----------------------------
     Header cart badge — updates any element with
     [data-cart-count] whenever the cart changes.
  ------------------------------ */
  function refreshCartBadge() {
    const badges = document.querySelectorAll("[data-cart-count]");
    if (!badges.length) return;
    const count = Cart.getItemCount();
    badges.forEach((badge) => {
      badge.textContent = count;
      badge.hidden = count === 0;
      badge.classList.remove("is-bump");
      // Re-trigger the bump keyframe (see animations.css) on every update
      void badge.offsetWidth;
      badge.classList.add("is-bump");
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    refreshCartBadge();
    window.BeautyPluzProducts?.ready
      .then(refreshCartBadge)
      .catch((err) => console.error("Beauty Pluz: cart badge could not refresh from the catalogue", err));
  });
  Cart.onChange(refreshCartBadge);

  /* =========================================================
     CART PAGE RENDERING
     Only runs on cart.html — every function below checks for
     its container before doing anything, so this file stays
     safe to include on every page (as it already is, for the
     header badge above).
     ========================================================= */

  const WHATSAPP_NUMBER = "10000000000"; // same number used in the header/footer WhatsApp links

  /** Builds the inline SVG markup for a cart row's product icon,
      reusing the single icon set defined in products.js. */
  function getIconMarkup(iconKey) {
    if (window.BeautyPluzProducts) {
      return window.BeautyPluzProducts.getIconMarkup(iconKey);
    }
    // products.js not loaded (shouldn't happen — included on every page)
    return "";
  }

  /** Renders just the numeric totals block (items / subtotal / delivery / grand total).
      The delivery-details form and WhatsApp button live outside this element in the
      HTML so re-rendering the totals never wipes out what the person has typed. */
  function renderSummary(items) {
    const totals = document.querySelector("[data-cart-summary-totals]");
    const whatsappBtn = document.querySelector("[data-order-whatsapp]");
    const checkoutBtn = document.querySelector("[data-checkout-sumup]");
    if (!totals) return;

    const subtotal = Cart.getSubtotal();
    const itemCount = Cart.getItemCount();

    totals.innerHTML = `
      <div class="cart-summary__row">
        <span>Number of Items</span>
        <span>${itemCount}</span>
      </div>
      <div class="cart-summary__row">
        <span>Subtotal</span>
        <span>${money(subtotal)}</span>
      </div>
      <div class="cart-summary__row">
        <span>Delivery</span>
        <span>${items.length === 0 ? "—" : money(DELIVERY_FEE)}</span>
      </div>
      <div class="cart-summary__row cart-summary__row--total">
        <span>Estimated Total</span>
        <span>${items.length === 0 ? "—" : money(subtotal + DELIVERY_FEE)}</span>
      </div>
    `;

    if (whatsappBtn) whatsappBtn.disabled = items.length === 0;
    if (checkoutBtn) {
      checkoutBtn.disabled = items.length === 0 || checkoutSubmitting;
      checkoutBtn.setAttribute("aria-busy", String(checkoutSubmitting));
    }
  }

  /** Builds the plain-text WhatsApp order message from cart items + customer details. */
  function buildWhatsAppMessage(items, customer) {
    const lines = items.map(
      (item) =>
        `• ${item.name} x${item.quantity} — ${money(item.price * item.quantity)}`
    );

    return [
      "Hello Beauty Pluz,",
      "",
      "I would like to order:",
      "",
      ...lines,
      "",
      `Total: ${money(Cart.getSubtotal())}`,
      "",
      `Customer Name: ${customer.name}`,
      `Phone Number: ${customer.phone}`,
      `Delivery Address: ${customer.address}`,
    ].join("\n");
  }

  /** Wires the delivery-details form + "Order via WhatsApp" button. */
  function initWhatsAppOrder() {
    const button = document.querySelector("[data-order-whatsapp]");
    const errorEl = document.querySelector("[data-delivery-error]");
    if (!button) return;

    const nameInput = document.querySelector("#customer-name");
    const phoneInput = document.querySelector("#customer-phone");
    const addressInput = document.querySelector("#customer-address");

    button.addEventListener("click", () => {
      const items = Cart.getItems();
      if (items.length === 0) return;

      const customer = {
        name: (nameInput?.value || "").trim(),
        phone: (phoneInput?.value || "").trim(),
        address: (addressInput?.value || "").trim(),
      };

      if (!customer.name || !customer.phone || !customer.address) {
        if (errorEl) {
          errorEl.textContent = "Please fill in your name, phone number, and delivery address.";
          errorEl.hidden = false;
        }

        const firstEmpty = !customer.name ? nameInput : !customer.phone ? phoneInput : addressInput;
        firstEmpty?.focus();
        return;
      }

      if (errorEl) errorEl.hidden = true;

      const message = buildWhatsAppMessage(items, customer);
      const recipient = String(window.BEAUTY_PLUZ_WHATSAPP_NUMBER || WHATSAPP_NUMBER).replace(/\D/g, "");
      const url = `https://wa.me/${recipient}?text=${encodeURIComponent(message)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    });

    // Clear the error as soon as the person starts fixing the form
    [nameInput, phoneInput, addressInput].forEach((input) => {
      input?.addEventListener("input", () => {
        if (errorEl && !errorEl.hidden) errorEl.hidden = true;
      });
    });
  }

  function showCheckoutMessage(errorEl, message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function setCheckoutLoading(button, loading) {
    const label = button.querySelector("[data-checkout-label]");
    if (label) {
      label.textContent = loading
        ? "Preparing secure checkout…"
        : "Pay securely with SumUp";
    }
    button.disabled = loading || Cart.getItems().length === 0;
    button.setAttribute("aria-busy", String(loading));
  }

  function normalizedCheckoutItems(items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
      return null;
    }
    const checkoutItems = [];
    for (const item of items) {
      if (
        typeof item.id !== "string" ||
        item.id.length < 1 ||
        item.id.length > 80 ||
        item.id.trim() !== item.id ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 99
      ) {
        return null;
      }
      checkoutItems.push({ id: item.id, quantity: item.quantity });
    }
    return checkoutItems.sort((left, right) => left.id.localeCompare(right.id));
  }

  function validateCheckoutDetails(fields) {
    const name = (fields.name?.value || "").trim();
    const phone = (fields.phone?.value || "").trim();
    const address = (fields.address?.value || "").trim();
    const countryCode = (fields.countryCode?.value || "").trim().toUpperCase();
    const postalCode = (fields.postalCode?.value || "")
      .trim()
      .replace(/[\s-]+/g, "")
      .toUpperCase();

    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      return { field: fields.name, message: "Enter your name (up to 120 characters)." };
    }
    if (
      phone.length < 5 ||
      phone.length > 40 ||
      !/^[+0-9() .-]+$/.test(phone) ||
      phone.replace(/[^0-9]/g, "").length < 5 ||
      phone.replace(/[^0-9]/g, "").length > 15
    ) {
      return { field: fields.phone, message: "Enter a valid phone number." };
    }
    if (
      address.length < 5 ||
      address.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(address)
    ) {
      return { field: fields.address, message: "Enter a valid delivery address (5–500 characters)." };
    }
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      return { field: fields.countryCode, message: "Enter a two-letter country code, such as GB." };
    }
    if (!/^[A-Z0-9]{2,12}$/.test(postalCode)) {
      return { field: fields.postalCode, message: "Enter a valid postal code." };
    }

    return {
      customerName: name,
      customerPhone: phone,
      shippingAddress: address,
      countryCode,
      postalCode,
    };
  }

  function randomCheckoutAccessToken() {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return window.btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function randomCheckoutIdempotencyKey() {
    if (typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function checkoutRequestFingerprint(request) {
    const canonicalRequest = {
      customerName: request.customerName,
      customerPhone: request.customerPhone,
      shippingAddress: request.shippingAddress,
      countryCode: request.countryCode,
      postalCode: request.postalCode,
      items: request.items,
    };
    const digest = await window.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(canonicalRequest)),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }

  async function getCheckoutAttempt(fingerprint) {
    let stored;
    try {
      const raw = window.sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error("Secure checkout could not be saved in this browser. Please enable session storage and try again.");
    }

    if (
      stored &&
      stored.fingerprint === fingerprint &&
      checkoutIdPattern.test(stored.idempotencyKey) &&
      checkoutTokenPattern.test(stored.checkoutAccessToken) &&
      stored.paymentStatus !== "paid" &&
      !["failed", "cancelled", "expired"].includes(stored.paymentStatus)
    ) {
      return stored;
    }
    if (
      stored?.fingerprint === fingerprint &&
      stored.paymentStatus === "paid"
    ) {
      throw new Error("This cart's checkout is already marked as paid. Please contact us before starting another payment.");
    }

    const attempt = {
      fingerprint,
      idempotencyKey: randomCheckoutIdempotencyKey(),
      checkoutAccessToken: randomCheckoutAccessToken(),
      items: [],
    };
    try {
      window.sessionStorage.setItem(
        CHECKOUT_ATTEMPT_STORAGE_KEY,
        JSON.stringify(attempt),
      );
    } catch {
      throw new Error("Secure checkout could not be saved in this browser. Please enable session storage and try again.");
    }
    return attempt;
  }

  function updateCheckoutAttempt(attempt, updates) {
    try {
      const current = JSON.parse(
        window.sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY) || "null",
      );
      if (
        !current ||
        current.fingerprint !== attempt.fingerprint ||
        current.idempotencyKey !== attempt.idempotencyKey
      ) {
        throw new Error("Checkout context changed.");
      }
      window.sessionStorage.setItem(
        CHECKOUT_ATTEMPT_STORAGE_KEY,
        JSON.stringify({ ...current, ...updates }),
      );
    } catch {
      throw new Error("Checkout details could not be retained in this browser. Your cart is unchanged; please retry.");
    }
  }

  function clearExpiredCheckoutAttempt(fingerprint) {
    try {
      const raw = window.sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      const stored = raw ? JSON.parse(raw) : null;
      if (stored?.fingerprint !== fingerprint) return false;
      window.sessionStorage.removeItem(CHECKOUT_ATTEMPT_STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function getCheckoutEndpoint() {
    const config = window.BEAUTY_PLUZ_BACKEND_CONFIG;
    if (
      !config ||
      typeof config.supabaseUrl !== "string" ||
      typeof config.supabaseAnonKey !== "string" ||
      !config.supabaseAnonKey
    ) {
      throw new Error("Secure checkout is not configured. Please contact us for help.");
    }
    let backendUrl;
    try {
      backendUrl = new URL(config.supabaseUrl);
    } catch {
      throw new Error("Secure checkout is not configured. Please contact us for help.");
    }
    if (
      backendUrl.protocol !== "https:" ||
      backendUrl.username ||
      backendUrl.password ||
      backendUrl.search ||
      backendUrl.hash
    ) {
      throw new Error("Secure checkout is not configured. Please contact us for help.");
    }
    return {
      url: new URL("/functions/v1/create-checkout-order", backendUrl.origin).href,
      anonKey: config.supabaseAnonKey,
    };
  }

  function trustedHostedCheckoutUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "checkout.sumup.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/pay\/[A-Za-z0-9-]+$/.test(url.pathname)
      ) {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function initSumUpCheckout() {
    const button = document.querySelector("[data-checkout-sumup]");
    const errorEl = document.querySelector("[data-delivery-error]");
    if (!button) return;

    const fields = {
      name: document.querySelector("#customer-name"),
      phone: document.querySelector("#customer-phone"),
      address: document.querySelector("#customer-address"),
      countryCode: document.querySelector("#customer-country"),
      postalCode: document.querySelector("#customer-postal-code"),
    };

    button.addEventListener("click", async () => {
      if (checkoutSubmitting) return;
      const cartItems = normalizedCheckoutItems(Cart.getItems());
      if (!cartItems) {
        showCheckoutMessage(errorEl, "Your cart is empty or contains too many items. Please review it and try again.");
        return;
      }

      const details = validateCheckoutDetails(fields);
      if (details.field) {
        showCheckoutMessage(errorEl, details.message);
        details.field?.focus();
        return;
      }
      if (errorEl) errorEl.hidden = true;

      checkoutSubmitting = true;
      setCheckoutLoading(button, true);
      let redirecting = false;
      try {
        const request = {
          ...details,
          items: cartItems,
        };
        const fingerprint = await checkoutRequestFingerprint(request);
        const attempt = await getCheckoutAttempt(fingerprint);
        updateCheckoutAttempt(attempt, { items: cartItems });
        const endpoint = getCheckoutEndpoint();
        let response;
        try {
          response = await fetch(endpoint.url, {
            method: "POST",
            headers: {
              apikey: endpoint.anonKey,
              Authorization: `Bearer ${endpoint.anonKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...request,
              idempotencyKey: attempt.idempotencyKey,
              checkoutAccessToken: attempt.checkoutAccessToken,
            }),
          });
        } catch {
          showCheckoutMessage(errorEl, "We couldn't reach secure checkout. Your cart is unchanged; please try again.");
          return;
        }

        let result;
        try {
          result = await response.json();
        } catch {
          showCheckoutMessage(errorEl, "Secure checkout returned an unexpected response. Your cart is unchanged; please try again.");
          return;
        }

        if (response.status === 202) {
          if (typeof result?.orderId === "string" && checkoutIdPattern.test(result.orderId)) {
            updateCheckoutAttempt(attempt, {
              orderId: result.orderId,
              paymentStatus: "pending",
            });
          }
          showCheckoutMessage(errorEl, "Your checkout is still being prepared. Please wait a moment and try again; your cart is unchanged.");
          return;
        }
        if (!response.ok) {
          let message = typeof result?.error === "string" && result.error.trim()
            ? result.error.slice(0, 300)
            : "We couldn't create your checkout. Your cart is unchanged; please try again.";
          if (
            response.status === 409 &&
            typeof result?.error === "string" &&
            /checkout request cannot be reused|checkout is no longer available/i.test(result.error)
          ) {
            message = "We couldn't resume this checkout. Your cart is unchanged. If you may already have paid, contact us before trying again.";
          }
          showCheckoutMessage(errorEl, message);
          return;
        }
        if (
          response.status !== 201 ||
          typeof result?.orderId !== "string" ||
          !checkoutIdPattern.test(result.orderId) ||
          !["pending", "paid", "failed", "cancelled", "expired"].includes(result.paymentStatus)
        ) {
          showCheckoutMessage(errorEl, "Secure checkout returned an unexpected response. Your cart is unchanged; please try again.");
          return;
        }
        updateCheckoutAttempt(attempt, {
          orderId: result.orderId,
          paymentStatus: result.paymentStatus,
          items: cartItems,
        });

        if (result.paymentStatus !== "pending") {
          if (result.paymentStatus === "expired") {
            const cleared = clearExpiredCheckoutAttempt(fingerprint);
            showCheckoutMessage(
              errorEl,
              cleared
                ? "This checkout has expired. You can start a new checkout."
                : "This checkout has expired. Please contact us before trying again.",
            );
            return;
          }
          const messages = {
            paid: "This order is already marked as paid. Please contact us before starting another payment.",
            failed: "This payment attempt was declined. Please contact us before retrying.",
            cancelled: "This checkout is no longer active. Please contact us for help.",
          };
          showCheckoutMessage(errorEl, messages[result.paymentStatus]);
          return;
        }

        const checkoutUrl = trustedHostedCheckoutUrl(result.hostedCheckoutUrl);
        if (!checkoutUrl) {
          showCheckoutMessage(errorEl, "We couldn't verify the secure payment page. Your cart is unchanged; please try again.");
          return;
        }

        redirecting = true;
        window.location.assign(checkoutUrl);
      } catch (error) {
        showCheckoutMessage(
          errorEl,
          error instanceof Error
            ? error.message
            : "Secure checkout is temporarily unavailable. Your cart is unchanged; please try again.",
        );
      } finally {
        if (!redirecting) {
          checkoutSubmitting = false;
          setCheckoutLoading(button, false);
        }
      }
    });

    Object.values(fields).forEach((field) => {
      field?.addEventListener("input", () => {
        if (errorEl && !errorEl.hidden) errorEl.hidden = true;
      });
    });
  }

  /** Formats a currency amount using the shared BeautyPluz helper if present. */
  function money(amount) {
    return window.BeautyPluz
      ? window.BeautyPluz.formatCurrency(amount)
      : "£" + Number(amount).toFixed(2);
  }

  /**
   * Builds one cart row <article> element for a given cart item.
   * All interaction (qty +/-, remove) is wired here via closures,
   * so the caller just has to insert the returned node.
   */
  function createCartRow(item) {
    const row = document.createElement("article");
    row.className = "cart-row";
    row.setAttribute("data-cart-row", item.id);

    row.innerHTML = `
      <a class="cart-row__media" href="product.html?id=${encodeURIComponent(item.id)}" aria-label="View ${item.name}">
        <img src="${item.image}" alt="${item.name}" />
      </a>
      <div class="cart-row__details">
        <p class="cart-row__category">${item.category || ""}</p>
        <h3 class="cart-row__name">${item.name}</h3>
        <p class="cart-row__price">${money(item.price)} <span>each</span></p>
        <button type="button" class="cart-row__remove" data-remove-item aria-label="Remove ${item.name} from cart">
          Remove
        </button>
      </div>
      <div class="qty-stepper" role="group" aria-label="Quantity for ${item.name}">
        <button type="button" class="qty-stepper__btn" data-decrement aria-label="Decrease quantity">−</button>
        <span class="qty-stepper__value" data-qty-value>${item.quantity}</span>
        <button type="button" class="qty-stepper__btn" data-increment aria-label="Increase quantity">+</button>
      </div>
      <div class="cart-row__total-wrap">
        <span class="cart-row__total-label">Subtotal</span>
        <p class="cart-row__total" data-line-total>${money(item.price * item.quantity)}</p>
      </div>
    `;

    row.querySelector("[data-increment]").addEventListener("click", () => {
      Cart.incrementItem(item.id);
    });

    row.querySelector("[data-decrement]").addEventListener("click", () => {
      Cart.decrementItem(item.id);
    });

    row.querySelector("[data-remove-item]").addEventListener("click", () => {
      row.classList.add("is-removing");
      window.setTimeout(() => Cart.removeItem(item.id), 180);
    });

    return row;
  }

  /** Main entry point: rebuilds the entire cart page from current state. */
  function renderCartPage() {
    const list = document.querySelector("[data-cart-list]");
    const emptyState = document.querySelector("[data-cart-empty]");
    const layout = document.querySelector("[data-cart-layout]");
    if (!list) return; // Not on cart.html — nothing to do.

    const items = Cart.getItems();

    list.innerHTML = "";

    if (items.length === 0) {
      if (layout) layout.hidden = true;
      if (emptyState) emptyState.hidden = false;
      renderSummary(items);
      return;
    }

    if (layout) layout.hidden = false;
    if (emptyState) emptyState.hidden = true;

    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(createCartRow(item)));
    list.appendChild(fragment);

    renderSummary(items);
  }

  function initCartPage() {
    if (!document.querySelector("[data-cart-list]")) return;
    Promise.resolve(window.BeautyPluzProducts?.ready)
      .then(() => {
        renderCartPage();
        refreshCartBadge();
        Cart.onChange(renderCartPage);
        initWhatsAppOrder();
        initSumUpCheckout();
      })
      .catch((err) => {
        console.error("Beauty Pluz: could not load product information for the cart", err);
        const list = document.querySelector("[data-cart-list]");
        if (list) list.textContent = "We could not load your cart right now. Please refresh the page or try again later.";
      });
  }

  document.addEventListener("DOMContentLoaded", initCartPage);
})();
