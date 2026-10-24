/* =========================================================
   BEAUTY PLUZ — CART.JS
   Shopping cart state, persisted to localStorage so it
   survives across index/shop/cart/contact page loads.
   This is the data/foundation layer only — cart.html markup
   and rendering templates will consume the Cart API once the
   page sections are built.
   ========================================================= */

(function () {
  "use strict";

  const STORAGE_KEY = "beautyPluzCart";

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

  const DELIVERY_ESTIMATE = "2–4 business days";
  let checkoutInProgress = false;

  /** Builds the inline SVG markup for a cart row's product icon,
      reusing the single icon set defined in products.js. */
  function getIconMarkup(iconKey) {
    if (window.BeautyPluzProducts) {
      return window.BeautyPluzProducts.getIconMarkup(iconKey);
    }
    // products.js not loaded (shouldn't happen — included on every page)
    return "";
  }

  /** Renders the cart totals without implying a browser-calculated payment amount. */
  function renderSummary(items) {
    const totals = document.querySelector("[data-cart-summary-totals]");
    const checkoutBtn = document.querySelector("[data-stripe-checkout]");
    if (!totals) return;

    const subtotal = Cart.getSubtotal();
    const itemCount = Cart.getItemCount();

    totals.innerHTML = `
      <div class="cart-summary__row">
        <span>Number of Items</span>
        <span>${itemCount}</span>
      </div>
      <div class="cart-summary__row">
        <span>Items subtotal</span>
        <span>${money(subtotal)}</span>
      </div>
      <div class="cart-summary__row">
        <span>Estimated Delivery</span>
        <span>${items.length === 0 ? "—" : DELIVERY_ESTIMATE}</span>
      </div>
      <div class="cart-summary__row cart-summary__row--total">
        <span>Delivery &amp; payment total</span>
        <span>Shown on Stripe</span>
      </div>
    `;

    if (checkoutBtn) checkoutBtn.disabled = items.length === 0 || checkoutInProgress;
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

  async function initStripeCheckout() {
    const form = document.querySelector("[data-checkout-form]");
    const button = document.querySelector("[data-stripe-checkout]");
    const status = document.querySelector("[data-checkout-status]");
    const error = document.querySelector("[data-checkout-error]");
    if (!form || !button || !status || !error) return;

    const nameInput = document.querySelector("#customer-name");
    const emailInput = document.querySelector("#customer-email");
    const phoneInput = document.querySelector("#customer-phone");
    const addressInput = document.querySelector("#customer-address");
    let checkoutModule;
    try {
      checkoutModule = await import("./stripe-checkout.mjs");
    } catch {
      button.disabled = true;
      error.textContent = "Secure checkout is unavailable right now. Please contact us.";
      error.hidden = false;
      return;
    }

    const handleSubmit = checkoutModule.createSingleFlight(async () => {
      const items = Cart.getItems();
      if (items.length === 0) {
        error.textContent = "Your cart is empty. Add an item before starting checkout.";
        error.hidden = false;
        return;
      }

      const customer = {
        name: nameInput?.value || "",
        email: emailInput?.value || "",
        phone: phoneInput?.value || "",
        shippingAddress: addressInput?.value || ""
      };
      let redirecting = false;
      button.disabled = true;
      button.textContent = "Connecting to secure checkout…";
      form.setAttribute("aria-busy", "true");
      status.textContent = "Preparing your secure checkout. Please wait.";
      error.hidden = true;

      try {
        const config = window.BEAUTY_PLUZ_BACKEND_CONFIG || {};
        const endpoint = checkoutModule.getCheckoutEndpoint(config);
        const requestDetails = checkoutModule.buildCheckoutRequest(items, customer);
        const idempotencyKey = await checkoutModule.getOrCreateIdempotencyKey(requestDetails);
        const payload = checkoutModule.buildCheckoutRequest(items, customer, idempotencyKey);
        const checkoutUrl = await checkoutModule.requestStripeCheckout(
          endpoint,
          payload
        );
        redirecting = true;
        window.location.assign(checkoutUrl);
      } catch (checkoutError) {
        status.textContent = "";
        if (checkoutError?.status === 409) {
          error.textContent = "This checkout may already have completed or expired. To avoid a duplicate payment, do not retry here; check your email or contact our team.";
        } else if (checkoutError?.status === 400) {
          error.textContent = "We could not verify the current cart. Please review your items and delivery details.";
        } else {
          error.textContent = checkoutError?.message ||
            "Secure checkout is temporarily unavailable. Please try again.";
        }
        error.hidden = false;
      } finally {
        checkoutInProgress = false;
        form.removeAttribute("aria-busy");
        if (!redirecting) {
          button.disabled = Cart.getItems().length === 0;
          button.textContent = "Pay securely with Stripe";
        }
      }
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      checkoutInProgress = true;
      void handleSubmit();
    });

    [nameInput, emailInput, phoneInput, addressInput].forEach((input) => {
      input?.addEventListener("input", () => {
        if (!error.hidden) error.hidden = true;
      });
    });
  }

  function initCartPage() {
    if (!document.querySelector("[data-cart-list]")) return;
    Promise.resolve(window.BeautyPluzProducts?.ready)
      .then(() => {
        renderCartPage();
        refreshCartBadge();
        Cart.onChange(renderCartPage);
        return initStripeCheckout();
      })
      .catch((err) => {
        console.error("Beauty Pluz: could not load product information for the cart", err);
        const list = document.querySelector("[data-cart-list]");
        if (list) list.textContent = "We could not load your cart right now. Please refresh the page or try again later.";
      });
  }

  document.addEventListener("DOMContentLoaded", initCartPage);
})();
