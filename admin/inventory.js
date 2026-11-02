import { supabase, verifyAdminSession } from "./client.js";

(() => {
  "use strict";

  const LOW_STOCK_THRESHOLD = 5;
  const rows = document.querySelector("[data-inventory-rows]");
  const empty = document.querySelector("[data-inventory-empty]");
  const status = document.querySelector("[data-inventory-status]");
  const tableWrap = document.querySelector("[data-inventory-table-wrap]");
  const state = { products: [] };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function setMessage(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
    status.hidden = !message;
  }

  function stockLabel(quantity) {
    if (quantity === null) return "Not tracked";
    if (quantity === 0) return "Out of stock";
    if (quantity <= LOW_STOCK_THRESHOLD) return "Low stock";
    return "In stock";
  }

  function safeImageUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(String(value), `${window.location.origin}/`);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && url.origin === window.location.origin)) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function getFilteredProducts() {
    const term = document.querySelector("[data-inventory-search]").value.trim().toLowerCase();
    const filter = document.querySelector("[data-inventory-filter]").value;
    return state.products.filter((product) => {
      const textMatch = !term || [product.id, product.name, product.category]
        .some((value) => String(value || "").toLowerCase().includes(term));
      const stockMatch = !filter
        || (filter === "low" && product.stock_quantity !== null && product.stock_quantity > 0 && product.stock_quantity <= LOW_STOCK_THRESHOLD)
        || (filter === "out" && product.stock_quantity === 0)
        || (filter === "untracked" && product.stock_quantity === null);
      return textMatch && stockMatch;
    });
  }

  function renderSummary() {
    const low = state.products.filter((product) => product.stock_quantity !== null && product.stock_quantity > 0 && product.stock_quantity <= LOW_STOCK_THRESHOLD).length;
    const out = state.products.filter((product) => product.stock_quantity === 0).length;
    const untracked = state.products.filter((product) => product.stock_quantity === null).length;
    document.querySelector("[data-inventory-summary]").innerHTML = `
      <article><span>Products tracked</span><strong>${state.products.length - untracked}</strong></article>
      <article class="inventory-summary__warning"><span>Low stock · 5 or fewer</span><strong>${low}</strong></article>
      <article class="inventory-summary__danger"><span>Out of stock</span><strong>${out}</strong></article>
      <article><span>Not tracked</span><strong>${untracked}</strong></article>
    `;
  }

  function renderProducts() {
    const products = getFilteredProducts();
    rows.innerHTML = products.map((product) => {
      const quantity = product.stock_quantity === null ? "" : String(product.stock_quantity);
      const imageUrl = safeImageUrl(product.image_url);
      const image = imageUrl
        ? `<img class="product-table__thumb" src="${escapeHtml(imageUrl)}" alt="" loading="lazy">`
        : '<span class="product-table__thumb" aria-hidden="true"></span>';
      const storefront = !product.is_published
        ? "Draft"
        : product.is_available
          ? "Published · available"
          : "Published · unavailable";
      return `<tr>
        <td><div class="product-table__product">${image}<span><span class="product-table__name">${escapeHtml(product.name)}</span><span class="product-table__id">${escapeHtml(product.id)}</span></span></div></td>
        <td>${escapeHtml(product.category)}</td>
        <td>${escapeHtml(storefront)}</td>
        <td><span class="inventory-stock inventory-stock--${product.stock_quantity === null ? "untracked" : product.stock_quantity === 0 ? "out" : product.stock_quantity <= LOW_STOCK_THRESHOLD ? "low" : "available"}">${escapeHtml(stockLabel(product.stock_quantity))}</span></td>
        <td>
          <form class="inventory-update" data-inventory-update="${escapeHtml(product.id)}">
            <label class="visually-hidden" for="stock-${escapeHtml(product.id)}">Stock quantity for ${escapeHtml(product.name)}</label>
            <input id="stock-${escapeHtml(product.id)}" name="quantity" type="number" min="0" max="2147483647" step="1" value="${escapeHtml(quantity)}" placeholder="Not tracked" aria-label="Quantity; leave blank for not tracked">
            <button class="product-table__action" type="submit">Save</button>
          </form>
        </td>
      </tr>`;
    }).join("");
    empty.hidden = products.length > 0;
    document.querySelector("[data-inventory-count]").textContent = `Showing ${products.length} of ${state.products.length} products · low stock is ${LOW_STOCK_THRESHOLD} or fewer`;
  }

  async function loadProducts() {
    setMessage("");
    tableWrap.setAttribute("aria-busy", "true");
    rows.innerHTML = '<tr><td class="product-table__empty" colspan="5">Loading inventory…</td></tr>';
    const { data, error } = await supabase
      .from("products")
      .select("id,name,category,image_url,stock_quantity,is_available,is_published")
      .order("name");
    if (error) throw error;
    state.products = data || [];
    renderSummary();
    renderProducts();
    tableWrap.setAttribute("aria-busy", "false");
    document.querySelector("[data-inventory-summary]").setAttribute("aria-busy", "false");
  }

  async function initialize() {
    const session = await verifyAdminSession();
    if (!session) {
      window.location.replace("/admin/login.html?reason=unauthorized");
      return;
    }

    document.querySelector("[data-inventory-search]").addEventListener("input", renderProducts);
    const filterControl = document.querySelector("[data-inventory-filter]");
    if (new URLSearchParams(window.location.search).get("filter") === "low") {
      filterControl.value = "low";
    }
    filterControl.addEventListener("change", renderProducts);
    document.querySelector("[data-inventory-refresh]").addEventListener("click", () => {
      loadProducts().catch((error) => {
        console.error("Beauty Pluz admin: inventory refresh failed.", error);
        setMessage(error.message || "Could not refresh inventory.", true);
      });
    });
    rows.addEventListener("submit", async (event) => {
      const form = event.target.closest("[data-inventory-update]");
      if (!form) return;
      event.preventDefault();
      const input = form.elements.namedItem("quantity");
      const submit = form.querySelector('button[type="submit"]');
      const quantityText = input.value.trim();
      const quantity = quantityText === "" ? null : Number(quantityText);
      if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0 || quantity > 2147483647)) {
        setMessage("Enter a whole stock quantity from 0 to 2,147,483,647, or leave blank for not tracked.", true);
        input.focus();
        return;
      }
      submit.disabled = true;
      setMessage("");
      try {
        const { error } = await supabase.rpc("set_product_stock_quantity", {
          target_product_id: form.dataset.inventoryUpdate,
          next_quantity: quantity,
        });
        if (error) throw error;
        const product = state.products.find((entry) => entry.id === form.dataset.inventoryUpdate);
        if (product) product.stock_quantity = quantity;
        renderSummary();
        renderProducts();
        setMessage(`Inventory updated for ${product?.name || "product"}.`);
      } catch (error) {
        console.error("Beauty Pluz admin: inventory update failed.", error);
        setMessage(error.message || "Could not update inventory.", true);
        submit.disabled = false;
      }
    });
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.replace("/admin/login.html");
    });
    await loadProducts();
  }

  initialize().catch((error) => {
    console.error("Beauty Pluz admin: inventory could not be initialized.", error);
    tableWrap.setAttribute("aria-busy", "false");
    document.querySelector("[data-inventory-summary]").setAttribute("aria-busy", "false");
    setMessage(error.message || "Could not load inventory.", true);
  });
})();
