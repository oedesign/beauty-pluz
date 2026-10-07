import { supabase, verifyAdminSession } from "./client.js";

(() => {
  "use strict";

  const app = document.querySelector("[data-admin-app]");
  if (!app) return;

  const tableBody = document.querySelector("[data-product-rows]");
  const tableEmpty = document.querySelector("[data-product-empty]");
  const resultCount = document.querySelector("[data-product-count]");
  const status = document.querySelector("[data-products-status]");
  const tableWrap = document.querySelector("[data-products-table-wrap]");
  const formStatus = document.querySelector("[data-product-form-status]");
  const dialog = document.querySelector("[data-product-dialog]");
  const form = document.querySelector("[data-product-form]");
  const preview = document.querySelector("[data-product-image-preview]");
  const previewImage = document.querySelector("[data-product-image-preview-img]");
  const saveButton = document.querySelector("[data-product-save]");
  const state = {
    products: [],
    imageUrl: null,
    originalImageUrl: null,
    removeImage: false,
    previewObjectUrl: null,
    page: 1,
  };
  const pageSize = 10;

  function setMessage(target, message, isError = false) {
    target.textContent = message;
    target.classList.toggle("is-error", isError);
    target.hidden = !message;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function money(value) {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(value);
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

  function isSellable(product) {
    return product.is_available && (product.stock_quantity === null || product.stock_quantity > 0);
  }

  function getFilteredProducts() {
    const term = document.querySelector("[data-product-search]").value.trim().toLowerCase();
    const category = document.querySelector("[data-product-category]").value;
    const availability = document.querySelector("[data-product-availability]").value;
    const sort = document.querySelector("[data-product-sort]").value;

    const matches = state.products.filter((product) => {
      const textMatch = !term || [product.id, product.name, product.category]
        .some((value) => value.toLowerCase().includes(term));
      const categoryMatch = !category || product.category === category;
      const available = isSellable(product);
      const availabilityMatch =
        !availability ||
        (availability === "available" && available) ||
        (availability === "unavailable" && !product.is_available) ||
        (availability === "out-of-stock" && product.is_available && product.stock_quantity === 0);
      return textMatch && categoryMatch && availabilityMatch;
    });

    const comparisons = {
      name: (a, b) => a.name.localeCompare(b.name),
      newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
      "price-asc": (a, b) => a.price - b.price,
      "price-desc": (a, b) => b.price - a.price,
      "stock-asc": (a, b) => (a.stock_quantity ?? Number.MAX_SAFE_INTEGER) - (b.stock_quantity ?? Number.MAX_SAFE_INTEGER),
    };
    return matches.sort(comparisons[sort] || comparisons.name);
  }

  function renderProducts() {
    const filtered = getFilteredProducts();
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    state.page = Math.min(state.page, pageCount);
    const products = filtered.slice((state.page - 1) * pageSize, state.page * pageSize);
    tableBody.innerHTML = products.map((product) => {
      const imageUrl = safeImageUrl(product.image_url);
      const image = imageUrl
        ? `<img class="product-table__thumb" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" />`
        : '<span class="product-table__thumb" aria-hidden="true"></span>';
      const price = product.sale_price === null
        ? money(product.price)
        : `${money(product.sale_price)}<span class="product-table__price-sale"><s>${money(product.price)}</s> sale</span>`;
      const stock = product.stock_quantity === null ? "Not tracked" : String(product.stock_quantity);
      const badges = [
        product.is_featured ? '<span class="product-table__badge">Featured</span>' : "",
        product.badge ? `<span class="product-table__badge">${escapeHtml(product.badge)}</span>` : "",
      ].join("");
      const published = product.is_published ? "Published" : "Draft";
      const availability = isSellable(product) ? "Available" : "Unavailable";

      return `<tr>
        <td><div class="product-table__product">${image}<span><span class="product-table__name">${escapeHtml(product.name)}${badges}</span><span class="product-table__id">${escapeHtml(product.id)}</span></span></div></td>
        <td>${escapeHtml(product.category)}</td>
        <td>${price}</td>
        <td>${escapeHtml(stock)}</td>
        <td>${published}<span class="product-table__muted">${availability}</span></td>
        <td><button class="product-table__action" type="button" data-edit-product="${escapeHtml(product.id)}">Edit</button><button class="product-table__action product-table__action--delete" type="button" data-delete-product="${escapeHtml(product.id)}">Delete</button></td>
      </tr>`;
    }).join("");

    const start = filtered.length ? (state.page - 1) * pageSize + 1 : 0;
    const end = Math.min(state.page * pageSize, filtered.length);
    tableEmpty.hidden = filtered.length > 0;
    tableEmpty.textContent = state.products.length
      ? "No products match those filters."
      : "No products yet. Add your first product to start building the catalogue.";
    resultCount.textContent = `Showing ${start}–${end} of ${filtered.length} matching products`;
    document.querySelector("[data-product-page]").textContent = `Page ${state.page} of ${pageCount}`;
    document.querySelector("[data-product-previous]").disabled = state.page <= 1;
    document.querySelector("[data-product-next]").disabled = state.page >= pageCount;
    refreshCategoryOptions();
  }

  function refreshCategoryOptions() {
    const categories = [...new Set(state.products.map((product) => product.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const filter = document.querySelector("[data-product-category]");
    const selected = filter.value;
    filter.innerHTML = '<option value="">All categories</option>' +
      categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("");
    filter.value = categories.includes(selected) ? selected : "";
    document.querySelector("#product-category-options").innerHTML =
      categories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");
  }

  async function loadProducts() {
    tableWrap.setAttribute("aria-busy", "true");
    tableBody.innerHTML = '<tr><td class="product-table__empty" colspan="6">Loading catalogue…</td></tr>';
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    state.products = data || [];
    state.page = 1;
    renderProducts();
    tableWrap.setAttribute("aria-busy", "false");
  }

  function clearPreviewUrl() {
    if (state.previewObjectUrl) {
      URL.revokeObjectURL(state.previewObjectUrl);
      state.previewObjectUrl = null;
    }
  }

  function showImage(url) {
    clearPreviewUrl();
    previewImage.src = url || "";
    preview.hidden = !url;
  }

  function resetForm() {
    form.reset();
    form.elements.namedItem("id").value = "";
    form.elements.namedItem("stock_quantity").value = "0";
    form.elements.namedItem("is_available").checked = true;
    form.elements.namedItem("is_published").checked = true;
    state.imageUrl = null;
    state.originalImageUrl = null;
    state.removeImage = false;
    showImage(null);
    setMessage(formStatus, "");
    saveButton.disabled = false;
  }

  function openCreateForm() {
    resetForm();
    document.querySelector("[data-product-dialog-title]").textContent = "Add product";
    dialog.showModal();
    form.elements.namedItem("name").focus();
  }

  function openEditForm(product) {
    resetForm();
    document.querySelector("[data-product-dialog-title]").textContent = "Edit product";
    for (const name of ["id", "name", "category", "badge", "price", "sale_price", "stock_quantity", "icon", "description"]) {
      const value = product[name];
      form.elements.namedItem(name).value = value === null ? "" : value;
    }
    form.elements.namedItem("is_available").checked = product.is_available;
    form.elements.namedItem("is_published").checked = product.is_published;
    form.elements.namedItem("is_featured").checked = product.is_featured;
    state.imageUrl = product.image_url;
    state.originalImageUrl = product.image_url;
    state.removeImage = false;
    showImage(product.image_url);
    dialog.showModal();
    form.elements.namedItem("name").focus();
  }

  function getPayload() {
    const formData = new FormData(form);
    const price = Number(formData.get("price"));
    const salePriceRaw = String(formData.get("sale_price") || "").trim();
    const stock = Number(formData.get("stock_quantity"));
    const name = String(formData.get("name") || "").trim();
    const category = String(formData.get("category") || "").trim();

    if (!name || name.length > 180) throw new Error("Enter a product name of up to 180 characters.");
    if (!category || category.length > 80) throw new Error("Enter a category of up to 80 characters.");
    if (!Number.isFinite(price) || price < 0) throw new Error("Enter a valid non-negative price.");
    if (!Number.isInteger(stock) || stock < 0) throw new Error("Stock quantity must be a non-negative whole number.");

    const salePrice = salePriceRaw ? Number(salePriceRaw) : null;
    if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0 || salePrice >= price)) {
      throw new Error("Sale price must be less than the regular price.");
    }

    return {
      name,
      description: String(formData.get("description") || "").trim(),
      category,
      price,
      sale_price: salePrice,
      image_url: state.removeImage ? null : state.imageUrl,
      badge: String(formData.get("badge") || ""),
      icon: String(formData.get("icon") || "balm"),
      stock_quantity: stock,
      is_available: formData.has("is_available"),
      is_published: formData.has("is_published"),
      is_featured: formData.has("is_featured"),
    };
  }

  function validateDuplicateName(name, id) {
    const duplicate = state.products.find((product) =>
      product.id !== id && product.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
    );
    if (duplicate) throw new Error(`A product named “${duplicate.name}” already exists.`);
  }

  function safeFileName(fileName) {
    const normalized = fileName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    return normalized.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "product-image";
  }

  function getStoragePath(publicUrl) {
    if (!publicUrl) return null;
    const marker = "/storage/v1/object/public/product-images/";
    const position = publicUrl.indexOf(marker);
    if (position < 0) return null;
    return decodeURIComponent(publicUrl.slice(position + marker.length));
  }

  async function uploadSelectedImage() {
    const file = form.elements.namedItem("image").files[0];
    if (!file) return state.imageUrl;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPEG, PNG, or WebP image.");
    }
    if (file.size > 5 * 1024 * 1024) throw new Error("Images must be 5 MB or smaller.");

    const path = `products/${crypto.randomUUID()}-${safeFileName(file.name)}`;
    const { error } = await supabase.storage.from("product-images").upload(path, file, {
      cacheControl: "31536000",
      contentType: file.type,
      upsert: false,
    });
    if (error) throw error;
    return supabase.storage.from("product-images").getPublicUrl(path).data.publicUrl;
  }

  async function removeStoredImage(publicUrl, ignoreOrderHistory = false) {
    const path = getStoragePath(publicUrl);
    if (!path) return true;
    if (!ignoreOrderHistory) {
      const { data: inOrderHistory, error: historyError } = await supabase.rpc(
        "product_image_is_in_order_history",
        { target_image_url: publicUrl }
      );
      if (historyError) throw historyError;
      if (inOrderHistory) return false;
    }
    const { error } = await supabase.storage.from("product-images").remove([path]);
    if (error) throw error;
    return true;
  }

  function errorMessage(error) {
    if (error?.code === "23505" || /products_name_ci_unique|duplicate key/i.test(error?.message || "")) {
      return "A product with that name already exists. Product names must be unique.";
    }
    if (error?.code === "42501" || error?.status === 401 || error?.status === 403) {
      return "The server did not authorize this operation. Sign in with an administrator account.";
    }
    return error?.message || "Something went wrong. Please try again.";
  }

  async function saveProduct(event) {
    event.preventDefault();
    setMessage(formStatus, "");
    saveButton.disabled = true;

    let uploadedImage = null;
    let committed = false;
    const previousImage = state.originalImageUrl;
    try {
      const session = await verifyAdminSession();
      if (!session) throw new Error("Administrator access is required. Sign in again.");

      const id = form.elements.namedItem("id").value;
      const payload = getPayload();
      validateDuplicateName(payload.name, id);
      const selectedFile = form.elements.namedItem("image").files[0];
      if (selectedFile) {
        uploadedImage = await uploadSelectedImage();
        payload.image_url = uploadedImage;
      }

      const result = id
        ? await supabase.from("products").update(payload).eq("id", id).select("*").single()
        : await supabase.from("products").insert(payload).select("*").single();
      if (result.error) throw result.error;
      if (!result.data) throw new Error("The server did not return the saved product.");
      committed = true;
      uploadedImage = null;

      let cleanupWarning = "";
      if (previousImage && previousImage !== result.data.image_url) {
        try {
          const removed = await removeStoredImage(previousImage);
          if (!removed) cleanupWarning = " The previous image was retained for historical orders.";
        } catch (cleanupError) {
          console.error("Beauty Pluz admin: saved product but could not remove the replaced image.", cleanupError);
          cleanupWarning = " The previous image could not be removed from storage.";
        }
      }

      try {
        await loadProducts();
      } catch (refreshError) {
        console.error("Beauty Pluz admin: product saved but list refresh failed.", refreshError);
        setMessage(status, "Product saved, but the catalogue could not refresh. Reload this page.", true);
        dialog.close();
        return;
      }
      setMessage(status, `Product saved successfully.${cleanupWarning}`);
      dialog.close();
      resetForm();
    } catch (error) {
      if (uploadedImage && !committed) {
        try {
          await removeStoredImage(uploadedImage, true);
        } catch (cleanupError) {
          console.error("Beauty Pluz admin: could not clean up an unused uploaded image.", cleanupError);
        }
      }
      console.error("Beauty Pluz admin: could not save product.", error);
      if (committed) {
        setMessage(status, "Product saved, but a follow-up step failed. Reload the catalogue before retrying.", true);
        dialog.close();
      } else {
        setMessage(formStatus, errorMessage(error), true);
      }
    } finally {
      saveButton.disabled = false;
    }
  }

  async function deleteProduct(id) {
    const product = state.products.find((entry) => entry.id === id);
    if (!product) return;
    const confirmed = window.confirm(
      `Delete “${product.name}”? This removes it from the catalogue. Saved order-item snapshots are retained.`
    );
    if (!confirmed) return;

    setMessage(status, "");
    let committed = false;
    try {
      const session = await verifyAdminSession();
      if (!session) throw new Error("Administrator access is required. Sign in again.");
      const { error } = await supabase.from("products").delete().eq("id", id);
      if (error) throw error;
      committed = true;
      await loadProducts();
      try {
        const removed = await removeStoredImage(product.image_url);
        if (!removed) {
          setMessage(status, "Product deleted. Its image was retained for historical orders.");
          return;
        }
      } catch (cleanupError) {
        console.error("Beauty Pluz admin: product deleted but its image could not be removed.", cleanupError);
        setMessage(status, "Product deleted, but its image could not be removed from storage.", true);
        return;
      }
      setMessage(status, "Product deleted.");
    } catch (error) {
      console.error("Beauty Pluz admin: could not delete product.", error);
      setMessage(
        status,
        committed ? "Product deleted, but the catalogue could not refresh. Reload this page." : errorMessage(error),
        true
      );
    }
  }

  async function initialize() {
    const session = await verifyAdminSession();
    if (!session) {
      window.location.replace("/admin/login.html?reason=unauthorized");
      return;
    }

    await loadProducts();
    document.querySelector("[data-product-add]").addEventListener("click", openCreateForm);
    form.addEventListener("submit", saveProduct);
    document.querySelector("[data-product-cancel]").addEventListener("click", () => dialog.close());
    document.querySelector("[data-product-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", resetForm);

    for (const selector of ["[data-product-search]", "[data-product-category]", "[data-product-availability]", "[data-product-sort]"]) {
      document.querySelector(selector).addEventListener("input", () => {
        state.page = 1;
        renderProducts();
      });
      document.querySelector(selector).addEventListener("change", () => {
        state.page = 1;
        renderProducts();
      });
    }
    document.querySelector("[data-product-previous]").addEventListener("click", () => {
      state.page -= 1;
      renderProducts();
    });
    document.querySelector("[data-product-next]").addEventListener("click", () => {
      state.page += 1;
      renderProducts();
    });

    tableBody.addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-edit-product]");
      const deleteButton = event.target.closest("[data-delete-product]");
      if (editButton) {
        const product = state.products.find((entry) => entry.id === editButton.dataset.editProduct);
        if (product) openEditForm(product);
      } else if (deleteButton) {
        deleteProduct(deleteButton.dataset.deleteProduct);
      }
    });

    form.elements.namedItem("image").addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (file) {
        state.removeImage = false;
        state.previewObjectUrl = URL.createObjectURL(file);
        previewImage.src = state.previewObjectUrl;
        preview.hidden = false;
      }
    });

    document.querySelector("[data-product-remove-image]").addEventListener("click", () => {
      form.elements.namedItem("image").value = "";
      state.imageUrl = null;
      state.removeImage = true;
      showImage(null);
    });

    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.replace("/admin/login.html");
    });

    if (new URLSearchParams(window.location.search).get("action") === "add") {
      openCreateForm();
    }
  }

  initialize().catch((error) => {
    console.error("Beauty Pluz admin: product management could not be initialized.", error);
    tableWrap.setAttribute("aria-busy", "false");
    setMessage(status, errorMessage(error), true);
  });
})();
