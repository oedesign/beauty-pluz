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

  /**
   * Cart item shape:
   * { id, name, price, image, quantity }
   */
  const Cart = {
    _listeners: [],

    getItems() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
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
      const qty = quantity && quantity > 0 ? quantity : 1;
      const items = this.getItems();
      const existing = items.find((item) => item.id === product.id);

      if (existing) {
        existing.quantity += qty;
      } else {
        items.push({
          id: product.id,
          name: product.name,
          price: product.price,
          image: product.image || "",
          icon: product.icon || "",
          category: product.category || "",
          quantity: qty,
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
        if (target) target.quantity = quantity;
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

  document.addEventListener("DOMContentLoaded", refreshCartBadge);
  Cart.onChange(refreshCartBadge);

  /* =========================================================
     CART PAGE RENDERING
     Only runs on cart.html — every function below checks for
     its container before doing anything, so this file stays
     safe to include on every page (as it already is, for the
     header badge above).
     ========================================================= */

  const WHATSAPP_NUMBER = "10000000000"; // same number used in the header/footer WhatsApp links
  const DELIVERY_ESTIMATE = "2–4 business days";

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
        <span>Estimated Delivery</span>
        <span>${items.length === 0 ? "—" : DELIVERY_ESTIMATE}</span>
      </div>
      <div class="cart-summary__row cart-summary__row--total">
        <span>Grand Total</span>
        <span>${money(subtotal)}</span>
      </div>
    `;

    if (whatsappBtn) whatsappBtn.disabled = items.length === 0;
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
      const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    });

    // Clear the error as soon as the person starts fixing the form
    [nameInput, phoneInput, addressInput].forEach((input) => {
      input?.addEventListener("input", () => {
        if (errorEl && !errorEl.hidden) errorEl.hidden = true;
      });
    });
  }

  /** Formats a dollar amount using the shared BeautyPluz helper if present. */
  function money(amount) {
    return window.BeautyPluz
      ? window.BeautyPluz.formatCurrency(amount)
      : "$" + Number(amount).toFixed(2);
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
      <div class="cart-row__media cart-row__media--${item.icon || "serum"}">
        ${getIconMarkup(item.icon)}
      </div>
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
    renderCartPage();
    Cart.onChange(renderCartPage);
    initWhatsAppOrder();
  }

  document.addEventListener("DOMContentLoaded", initCartPage);
})();
