import { supabase, verifyAdminSession } from "./client.js";

(() => {
  "use strict";

  const app = document.querySelector("[data-admin-app]");
  if (!app) return;

  const rows = document.querySelector("[data-order-rows]");
  const empty = document.querySelector("[data-orders-empty]");
  const status = document.querySelector("[data-orders-status]");
  const count = document.querySelector("[data-orders-count]");
  const dialog = document.querySelector("[data-order-dialog]");
  const detail = document.querySelector("[data-order-detail-content]");
  const detailStatus = document.querySelector("[data-order-detail-status]");
  const pageSize = 25;
  const state = { orders: [], total: 0, offset: 0, requestId: 0, selectedOrderId: null };

  const fulfillmentStatuses = ["pending", "processing", "shipped", "delivered", "cancelled"];
  const paymentLabels = {
    unverified: "Unverified",
    pending: "Pending",
    paid: "Paid (verified)",
    failed: "Failed",
    refunded: "Refunded",
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function formatMoney(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value));
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function titleCase(value) {
    return String(value || "unknown").replace(/(^|-)\w/g, (part) => part.toUpperCase());
  }

  function setMessage(target, message, isError = false) {
    target.textContent = message;
    target.classList.toggle("is-error", isError);
    target.hidden = !message;
  }

  function paymentStatusLabel(value) {
    return paymentLabels[value] || "Unverified";
  }

  function renderOrders() {
    rows.innerHTML = state.orders.map((order) => `
      <tr>
        <td><strong>#${escapeHtml(String(order.id).slice(0, 8))}</strong><span class="product-table__muted">${escapeHtml(formatDate(order.createdAt))}</span></td>
        <td>${escapeHtml(order.customerName || "Customer details unavailable")}<span class="product-table__muted">${escapeHtml(order.customerEmail || order.customerPhone || "")}</span></td>
        <td>${escapeHtml(order.itemCount ?? 0)}</td>
        <td>${escapeHtml(formatMoney(order.total))}</td>
        <td><span class="order-status order-status--${escapeHtml(order.fulfillmentStatus)}">${escapeHtml(titleCase(order.fulfillmentStatus))}</span></td>
        <td><span class="order-payment">${escapeHtml(paymentStatusLabel(order.paymentStatus))}</span>${order.paymentReference ? `<span class="product-table__muted">${escapeHtml(order.paymentReference)}</span>` : ""}</td>
        <td><button class="product-table__action" type="button" data-order-open="${escapeHtml(order.id)}">View</button></td>
      </tr>
    `).join("");

    empty.hidden = state.orders.length > 0;
    count.textContent = `${state.total} recorded ${state.total === 1 ? "order" : "orders"}`;
    const currentPage = Math.floor(state.offset / pageSize) + 1;
    const totalPages = Math.max(1, Math.ceil(state.total / pageSize));
    document.querySelector("[data-orders-page]").textContent = `Page ${currentPage} of ${totalPages}`;
    document.querySelector("[data-orders-previous]").disabled = state.offset === 0;
    document.querySelector("[data-orders-next]").disabled = state.offset + state.orders.length >= state.total;
  }

  async function loadOrders() {
    const requestId = ++state.requestId;
    setMessage(status, "");
    count.textContent = "Loading recorded orders…";
    rows.setAttribute("aria-busy", "true");
    rows.innerHTML = '<tr><td class="product-table__empty" colspan="7">Loading orders…</td></tr>';
    const { data, error } = await supabase.rpc("get_admin_orders", {
      search_term: document.querySelector("[data-order-search]").value.trim() || null,
      status_filter: document.querySelector("[data-order-status-filter]").value || null,
      result_limit: pageSize,
      result_offset: state.offset,
    });
    if (error) throw error;
    if (requestId !== state.requestId) return;
    rows.setAttribute("aria-busy", "false");
    state.orders = Array.isArray(data?.orders) ? data.orders : [];
    state.total = Number(data?.total) || 0;
    renderOrders();
  }

  function paymentPanel(order) {
    const reference = order.paymentReference
      ? `<p><strong>Transaction reference:</strong> ${escapeHtml(order.paymentReference)}</p>`
      : "<p>No verified transaction reference recorded.</p>";
    const provider = order.paymentProvider
      ? `<p><strong>Provider:</strong> ${escapeHtml(order.paymentProvider)}</p>`
      : "";
    return `<section class="order-detail-panel">
      <h3>Payment</h3>
      <p><strong>Status:</strong> <span class="order-payment">${escapeHtml(paymentStatusLabel(order.paymentStatus))}</span></p>
      ${provider}${reference}
      <p class="order-detail-hint">Payment information is read-only and must come from verified provider data.</p>
    </section>`;
  }

  function renderOrderDetails(order) {
    const items = Array.isArray(order.items) ? order.items : [];
    const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
    const itemMarkup = items.length
      ? items.map((item) => `
        <tr>
          <td>${escapeHtml(item.productName || "Product unavailable")}${item.productId ? `<span class="product-table__muted">ID: ${escapeHtml(item.productId)}</span>` : ""}</td>
          <td>${escapeHtml(item.quantity)}</td>
          <td>${escapeHtml(formatMoney(item.unitPrice))}</td>
          <td>${escapeHtml(formatMoney(item.lineTotal))}</td>
        </tr>
      `).join("")
      : '<tr><td colspan="4">No saved item snapshots are available.</td></tr>';
    const historyMarkup = [
      `<li><span>Order recorded</span><time>${escapeHtml(formatDate(order.createdAt))}</time></li>`,
      ...history.map((entry) => `<li><span>${escapeHtml(titleCase(entry.previousStatus))} → ${escapeHtml(titleCase(entry.nextStatus))}</span><time>${escapeHtml(formatDate(entry.changedAt))}</time></li>`),
    ].join("");

    document.querySelector("[data-order-dialog-title]").textContent = `Order ${order.id}`;
    detail.innerHTML = `
      <div class="order-detail-grid">
        <section class="order-detail-panel">
          <h3>Customer</h3>
          <p><strong>${escapeHtml(order.customerName || "Customer details unavailable")}</strong></p>
          ${order.customerEmail ? `<p><a href="mailto:${escapeHtml(order.customerEmail)}">${escapeHtml(order.customerEmail)}</a></p>` : ""}
          ${order.customerPhone ? `<p><a href="tel:${escapeHtml(order.customerPhone)}">${escapeHtml(order.customerPhone)}</a></p>` : ""}
          ${order.shippingAddress ? `<p class="order-detail-address">${escapeHtml(order.shippingAddress)}</p>` : ""}
        </section>
        ${paymentPanel(order)}
      </div>
      <section class="order-detail-panel order-detail-panel--wide">
        <h3>Items</h3>
        <div class="product-table-wrap">
          <table class="product-table order-items-table">
            <thead><tr><th>Product snapshot</th><th>Qty</th><th>Unit price</th><th>Line total</th></tr></thead>
            <tbody>${itemMarkup}</tbody>
          </table>
        </div>
        <dl class="order-totals">
          <div><dt>Subtotal</dt><dd>${escapeHtml(formatMoney(order.subtotal))}</dd></div>
          <div><dt>Delivery</dt><dd>${escapeHtml(formatMoney(order.deliveryFee))}</dd></div>
          <div><dt>Order total</dt><dd>${escapeHtml(formatMoney(order.total))}</dd></div>
        </dl>
      </section>
      <section class="order-detail-panel order-detail-panel--wide">
        <h3>Fulfilment</h3>
        <form class="order-status-form" data-order-status-form>
          <label class="product-form__field">
            <span>Status</span>
            <select name="fulfillmentStatus">${fulfillmentStatuses.map((value) => `<option value="${value}"${value === order.fulfillmentStatus ? " selected" : ""}>${escapeHtml(titleCase(value))}</option>`).join("")}</select>
          </label>
          <button class="admin-button" type="submit">Update status</button>
        </form>
        <h3 class="order-history-heading">Order history</h3>
        <ol class="order-history">${historyMarkup}</ol>
      </section>
    `;
  }

  async function showOrder(orderId) {
    setMessage(detailStatus, "");
    const { data, error } = await supabase.rpc("get_admin_order_details", { target_order_id: orderId });
    if (error) throw error;
    if (!data) throw new Error("The server returned no details for this order.");
    state.selectedOrderId = orderId;
    renderOrderDetails(data);
    if (!dialog.open) dialog.showModal();
  }

  async function initialize() {
    const session = await verifyAdminSession();
    if (!session) {
      window.location.replace("/admin/login.html?reason=unauthorized");
      return;
    }

    let searchTimer;
    document.querySelector("[data-order-search]").addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.offset = 0;
        loadOrders().catch((error) => {
          console.error("Beauty Pluz admin: order search failed.", error);
          setMessage(status, error.message || "Could not search orders.", true);
        });
      }, 250);
    });
    document.querySelector("[data-order-status-filter]").addEventListener("change", () => {
      state.offset = 0;
      loadOrders().catch((error) => {
        console.error("Beauty Pluz admin: order filtering failed.", error);
        setMessage(status, error.message || "Could not filter orders.", true);
      });
    });
    document.querySelector("[data-orders-refresh]").addEventListener("click", () => {
      loadOrders().catch((error) => {
        console.error("Beauty Pluz admin: order refresh failed.", error);
        setMessage(status, error.message || "Could not refresh orders.", true);
      });
    });
    document.querySelector("[data-orders-previous]").addEventListener("click", () => {
      state.offset = Math.max(0, state.offset - pageSize);
      loadOrders().catch((error) => {
        console.error("Beauty Pluz admin: previous order page failed.", error);
        setMessage(status, error.message || "Could not load orders.", true);
      });
    });
    document.querySelector("[data-orders-next]").addEventListener("click", () => {
      state.offset += pageSize;
      loadOrders().catch((error) => {
        console.error("Beauty Pluz admin: next order page failed.", error);
        setMessage(status, error.message || "Could not load orders.", true);
      });
    });
    rows.addEventListener("click", (event) => {
      const button = event.target.closest("[data-order-open]");
      if (!button) return;
      showOrder(button.dataset.orderOpen).catch((error) => {
        console.error("Beauty Pluz admin: order details failed to load.", error);
        setMessage(status, error.message || "Could not load order details.", true);
      });
    });
    detail.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-order-status-form]");
      if (!form) return;
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      setMessage(detailStatus, "");
      try {
        const nextStatus = new FormData(form).get("fulfillmentStatus");
        const { error } = await supabase.rpc("set_order_fulfillment_status", {
          target_order_id: state.selectedOrderId,
          next_status: nextStatus,
        });
        if (error) throw error;
        await loadOrders();
        await showOrder(state.selectedOrderId);
        setMessage(detailStatus, "Fulfilment status updated.");
      } catch (error) {
        console.error("Beauty Pluz admin: fulfilment update failed.", error);
        setMessage(detailStatus, error.message || "Could not update fulfilment status.", true);
        submit.disabled = false;
      }
    });
    document.querySelector("[data-order-close]").addEventListener("click", () => dialog.close());
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.replace("/admin/login.html");
    });
    await loadOrders();
  }

  initialize().catch((error) => {
    console.error("Beauty Pluz admin: orders could not be initialized.", error);
    rows.setAttribute("aria-busy", "false");
    setMessage(status, error.message || "Could not load orders.", true);
  });
})();
