import { supabase, verifyAdminSession } from "./client.js";

(() => {
  "use strict";

  const app = document.querySelector("[data-admin-app]");
  if (!app) return;

  const status = document.querySelector("[data-homepage-status]");
  const publishState = document.querySelector("[data-homepage-publish-state]");
  const slideList = document.querySelector("[data-slide-list]");
  const promotionList = document.querySelector("[data-promotion-list]");
  const featuredList = document.querySelector("[data-featured-list]");
  const previewDialog = document.querySelector("[data-homepage-preview-dialog]");
  const previewContent = document.querySelector("[data-homepage-preview-content]");
  const fallbackHeroImage = "../images/hero/skincare-product-hero-image1.jpeg";
  const state = {
    draft: null,
    published: null,
    products: [],
    cleanupCandidates: new Set(),
    uploadObjectUrls: new Map(),
    lastPublishedAt: null,
    saving: false,
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

  function storeAssetUrl(value) {
    const path = String(value || "");
    if (/^https:\/\//i.test(path)) return path;
    return new URL(path.replace(/^\/+/, ""), `${window.location.origin}/`).href;
  }

  function setUploadPreview(key, file) {
    const previousUrl = state.uploadObjectUrls.get(key);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const previewUrl = URL.createObjectURL(file);
    state.uploadObjectUrls.set(key, previewUrl);
    return previewUrl;
  }

  function clearUploadPreview(key) {
    const previewUrl = state.uploadObjectUrls.get(key);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    state.uploadObjectUrls.delete(key);
  }

  function setMessage(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
    status.hidden = !message;
  }

  function defaultSlide() {
    return {
      id: `hero-${crypto.randomUUID()}`,
      enabled: true,
      image: "images/hero/skincare-product-hero-image1.jpeg",
      theme: "sage",
      eyebrow: "",
      heading: "",
      description: "",
      ctaText: "Shop Now",
      ctaLink: "shop.html",
      secondaryCtaText: "",
      secondaryCtaLink: "",
      align: "left",
    };
  }

  function defaultPromotion() {
    return {
      id: `promo-${crypto.randomUUID()}`,
      enabled: true,
      image: "",
      eyebrow: "Limited Time",
      heading: "",
      description: "",
      code: "",
      ctaText: "Shop Now",
      ctaLink: "shop.html",
    };
  }

  function validLink(value, label) {
    const link = String(value || "").trim();
    if (!link) return;
    if (link.startsWith("//") || /^(javascript|data|vbscript):/i.test(link)) {
      throw new Error(`${label} must be a same-site path or a secure https:// link.`);
    }
    let parsed;
    try {
      parsed = new URL(link, window.location.href);
    } catch {
      throw new Error(`${label} is not a valid link.`);
    }
    if (parsed.protocol !== "https:" && parsed.origin !== window.location.origin) {
      throw new Error(`${label} must be a same-site path or a secure https:// link.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${label} is not a supported link.`);
    }
  }

  function validateContent(content) {
    if (!content.slides.some((slide) => slide.enabled && slide.image)) {
      throw new Error("At least one enabled hero slide with an image is required.");
    }
    if (content.slides.length > 20) throw new Error("You can add up to 20 hero slides.");
    if (content.promotions.length > 10) throw new Error("You can add up to 10 promotional banners.");
    if (content.featuredProductIds.length > 12) throw new Error("Choose up to 12 featured products.");
    if (new Set(content.featuredProductIds).size !== content.featuredProductIds.length) {
      throw new Error("A product can only appear once in the featured collection.");
    }

    for (const [index, slide] of content.slides.entries()) {
      if (slide.heading.length > 120 || slide.description.length > 500 || slide.eyebrow.length > 80) {
        throw new Error(`Slide ${index + 1} contains text longer than allowed.`);
      }
      if (slide.ctaText) validLink(slide.ctaLink, `Slide ${index + 1} CTA link`);
      if (slide.secondaryCtaText) validLink(slide.secondaryCtaLink, `Slide ${index + 1} secondary CTA link`);
    }

    for (const [index, promotion] of content.promotions.entries()) {
      if (promotion.enabled && !promotion.heading.trim()) {
        throw new Error(`Enter a heading for promotional banner ${index + 1}.`);
      }
      if (promotion.ctaText) validLink(promotion.ctaLink, `Banner ${index + 1} CTA link`);
    }

    const knownProducts = new Set(state.products.filter((product) => product.is_published).map((product) => product.id));
    if (content.featuredProductIds.some((id) => !knownProducts.has(id))) {
      throw new Error("Featured products must be existing, published products.");
    }
    if (content.announcement.text.length > 180) {
      throw new Error("Announcement text must be 180 characters or fewer.");
    }
  }

  function renderSlides() {
    slideList.innerHTML = state.draft.slides.map((slide, index) => {
      const preview = state.uploadObjectUrls.get(`slide:${slide.id}`) || (slide.image ? storeAssetUrl(slide.image) : fallbackHeroImage);
      return `<article class="homepage-editor-card" data-slide-card="${escapeHtml(slide.id)}">
        <header class="homepage-editor-card__header">
          <div><span class="homepage-editor-card__number">Slide ${index + 1}</span><label class="product-form__check"><input type="checkbox" data-slide-field="enabled" data-slide-id="${escapeHtml(slide.id)}"${slide.enabled ? " checked" : ""}><span>Enabled</span></label></div>
          <div class="homepage-editor-card__actions">
            <button class="product-table__action" type="button" data-slide-move="-1" data-slide-id="${escapeHtml(slide.id)}" aria-label="Move slide ${index + 1} up"${index === 0 ? " disabled" : ""}>↑</button>
            <button class="product-table__action" type="button" data-slide-move="1" data-slide-id="${escapeHtml(slide.id)}" aria-label="Move slide ${index + 1} down"${index === state.draft.slides.length - 1 ? " disabled" : ""}>↓</button>
            <button class="product-table__action product-table__action--delete" type="button" data-slide-delete="${escapeHtml(slide.id)}">Remove</button>
          </div>
        </header>
        <div class="homepage-slide-editor">
          <div class="homepage-slide-editor__image">
            <img src="${escapeHtml(preview)}" alt="Slide preview" data-slide-preview="${escapeHtml(slide.id)}">
            <label class="product-form__field"><span>Upload slide image (JPEG, PNG, WebP; max 5 MB)</span><input type="file" accept="image/jpeg,image/png,image/webp" data-slide-upload="${escapeHtml(slide.id)}"></label>
            <button class="admin-button admin-button--quiet" type="button" data-slide-remove-image="${escapeHtml(slide.id)}">Use fallback image</button>
          </div>
          <div class="homepage-slide-editor__fields">
            <label class="product-form__field"><span>Eyebrow</span><input maxlength="80" data-slide-field="eyebrow" data-slide-id="${escapeHtml(slide.id)}" value="${escapeHtml(slide.eyebrow)}"></label>
            <label class="product-form__field"><span>Heading</span><input maxlength="120" data-slide-field="heading" data-slide-id="${escapeHtml(slide.id)}" value="${escapeHtml(slide.heading)}"></label>
            <label class="product-form__field"><span>Description</span><textarea maxlength="500" rows="3" data-slide-field="description" data-slide-id="${escapeHtml(slide.id)}">${escapeHtml(slide.description)}</textarea></label>
            <div class="homepage-inline-fields">
              <label class="product-form__field"><span>CTA text</span><input maxlength="40" data-slide-field="ctaText" data-slide-id="${escapeHtml(slide.id)}" value="${escapeHtml(slide.ctaText)}"></label>
              <label class="product-form__field"><span>CTA link</span><input maxlength="500" data-slide-field="ctaLink" data-slide-id="${escapeHtml(slide.id)}" value="${escapeHtml(slide.ctaLink)}" placeholder="shop.html"></label>
            </div>
            <details class="homepage-secondary-cta">
              <summary>Optional second CTA</summary>
              <div class="homepage-inline-fields">
                <label class="product-form__field"><span>Second CTA text</span><input maxlength="40" data-slide-field="secondaryCtaText" data-slide-id="${escapeHtml(slide.id)}" value="${escapeHtml(slide.secondaryCtaText)}"></label>
                <label class="product-form__field"><span>Second CTA link</span><input maxlength="500" data-slide-field="secondaryCtaLink" data-slide-id="${escapeHtml(slide.id)}" value="${escapeHtml(slide.secondaryCtaLink)}" placeholder="shop.html"></label>
              </div>
            </details>
            <div class="homepage-inline-fields">
              <label class="product-form__field"><span>Colour theme</span><select data-slide-field="theme" data-slide-id="${escapeHtml(slide.id)}">
                <option value="sage"${slide.theme === "sage" ? " selected" : ""}>Sage</option>
                <option value="rose"${slide.theme === "rose" ? " selected" : ""}>Rose</option>
                <option value="blush"${slide.theme === "blush" ? " selected" : ""}>Blush</option>
              </select></label>
              <label class="product-form__field"><span>Text alignment</span><select data-slide-field="align" data-slide-id="${escapeHtml(slide.id)}">
                <option value="left"${slide.align !== "right" ? " selected" : ""}>Left</option>
                <option value="right"${slide.align === "right" ? " selected" : ""}>Right</option>
              </select></label>
            </div>
          </div>
        </div>
      </article>`;
    }).join("");
  }

  function renderFeaturedProducts() {
    const selected = new Set(state.draft.featuredProductIds);
    featuredList.innerHTML = state.products.map((product) => {
      const index = state.draft.featuredProductIds.indexOf(product.id);
      const selectedProduct = index >= 0;
      return `<div class="homepage-featured-row">
        <label class="product-form__check"><input type="checkbox" data-feature-toggle="${escapeHtml(product.id)}"${selectedProduct ? " checked" : ""}${!product.is_published ? " disabled" : ""}><span>${escapeHtml(product.name)}</span></label>
        <span class="homepage-featured-row__meta">${escapeHtml(product.category)} · ${product.is_published ? "Published" : "Draft"}</span>
        ${selectedProduct ? `<span class="homepage-editor-card__actions"><span class="homepage-featured-row__position">#${index + 1}</span><button class="product-table__action" type="button" data-feature-move="-1" data-product-id="${escapeHtml(product.id)}" aria-label="Move ${escapeHtml(product.name)} up"${index === 0 ? " disabled" : ""}>↑</button><button class="product-table__action" type="button" data-feature-move="1" data-product-id="${escapeHtml(product.id)}" aria-label="Move ${escapeHtml(product.name)} down"${index === state.draft.featuredProductIds.length - 1 ? " disabled" : ""}>↓</button></span>` : ""}
      </div>`;
    }).join("");
    if (!state.products.length) featuredList.innerHTML = '<p class="homepage-panel__hint">No products are available yet. Add products first.</p>';
  }

  function renderPromotions() {
    promotionList.innerHTML = state.draft.promotions.map((promotion, index) => {
      const preview = state.uploadObjectUrls.get(`promotion:${promotion.id}`) || (promotion.image ? storeAssetUrl(promotion.image) : "");
      return `<article class="homepage-editor-card homepage-promotion-card" data-promotion-card="${escapeHtml(promotion.id)}">
        <header class="homepage-editor-card__header">
          <div><span class="homepage-editor-card__number">Banner ${index + 1}</span><label class="product-form__check"><input type="checkbox" data-promotion-field="enabled" data-promotion-id="${escapeHtml(promotion.id)}"${promotion.enabled ? " checked" : ""}><span>Enabled</span></label></div>
          <div class="homepage-editor-card__actions">
            <button class="product-table__action" type="button" data-promotion-move="-1" data-promotion-id="${escapeHtml(promotion.id)}" aria-label="Move banner ${index + 1} up"${index === 0 ? " disabled" : ""}>↑</button>
            <button class="product-table__action" type="button" data-promotion-move="1" data-promotion-id="${escapeHtml(promotion.id)}" aria-label="Move banner ${index + 1} down"${index === state.draft.promotions.length - 1 ? " disabled" : ""}>↓</button>
            <button class="product-table__action product-table__action--delete" type="button" data-promotion-delete="${escapeHtml(promotion.id)}">Remove</button>
          </div>
        </header>
        <div class="homepage-promotion-editor">
          <div class="homepage-promotion-editor__image">
            ${preview ? `<img src="${escapeHtml(preview)}" alt="Banner image preview" data-promotion-preview="${escapeHtml(promotion.id)}">` : '<div class="homepage-promotion-editor__placeholder">No image selected</div>'}
            <label class="product-form__field"><span>Optional banner image (JPEG, PNG, WebP; max 5 MB)</span><input type="file" accept="image/jpeg,image/png,image/webp" data-promotion-upload="${escapeHtml(promotion.id)}"></label>
            ${preview ? `<button class="admin-button admin-button--quiet" type="button" data-promotion-remove-image="${escapeHtml(promotion.id)}">Remove image</button>` : ""}
          </div>
          <div class="homepage-promotion-editor__fields">
            <label class="product-form__field"><span>Eyebrow</span><input maxlength="80" data-promotion-field="eyebrow" data-promotion-id="${escapeHtml(promotion.id)}" value="${escapeHtml(promotion.eyebrow)}"></label>
            <label class="product-form__field"><span>Heading</span><input maxlength="120" data-promotion-field="heading" data-promotion-id="${escapeHtml(promotion.id)}" value="${escapeHtml(promotion.heading)}"></label>
            <label class="product-form__field"><span>Description</span><textarea maxlength="500" rows="3" data-promotion-field="description" data-promotion-id="${escapeHtml(promotion.id)}">${escapeHtml(promotion.description)}</textarea></label>
            <div class="homepage-inline-fields">
              <label class="product-form__field"><span>Offer code (optional)</span><input maxlength="40" data-promotion-field="code" data-promotion-id="${escapeHtml(promotion.id)}" value="${escapeHtml(promotion.code)}"></label>
              <label class="product-form__field"><span>CTA text</span><input maxlength="40" data-promotion-field="ctaText" data-promotion-id="${escapeHtml(promotion.id)}" value="${escapeHtml(promotion.ctaText)}"></label>
              <label class="product-form__field"><span>CTA link</span><input maxlength="500" data-promotion-field="ctaLink" data-promotion-id="${escapeHtml(promotion.id)}" value="${escapeHtml(promotion.ctaLink)}"></label>
            </div>
          </div>
        </div>
      </article>`;
    }).join("");
    if (!state.draft.promotions.length) {
      promotionList.innerHTML = '<p class="homepage-panel__hint">No promotional banners yet. Add a banner to create one.</p>';
    }
  }

  function renderContent() {
    document.querySelector("[data-announcement-enabled]").checked = Boolean(state.draft.announcement.enabled);
    document.querySelector("[data-announcement-copy]").value = state.draft.announcement.text || "";
    renderSlides();
    renderFeaturedProducts();
    renderPromotions();
    publishState.textContent = state.lastPublishedAt
      ? `Last published ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(state.lastPublishedAt))}`
      : "No published timestamp available";
  }

  function currentContent() {
    state.draft.announcement.enabled = document.querySelector("[data-announcement-enabled]").checked;
    state.draft.announcement.text = document.querySelector("[data-announcement-copy]").value.trim();
    return state.draft;
  }

  async function loadContent() {
    const session = await verifyAdminSession();
    if (!session) {
      window.location.replace("/admin/login.html?reason=unauthorized");
      return;
    }
    const [{ data: content, error: contentError }, { data: products, error: productsError }] = await Promise.all([
      supabase.rpc("get_admin_homepage_content"),
      supabase.from("products").select("id,name,category,is_published").order("name"),
    ]);
    if (contentError) throw contentError;
    if (productsError) throw productsError;
    if (!content?.draft || !content?.published) throw new Error("Homepage content is not initialized. Apply the homepage content migration.");
    state.draft = JSON.parse(JSON.stringify(content.draft));
    state.published = content.published;
    state.products = products || [];
    state.lastPublishedAt = content.publishedAt || null;
    renderContent();
  }

  function moveItem(list, id, delta, idField = "id") {
    const index = typeof list[0] === "string"
      ? list.indexOf(id)
      : list.findIndex((item) => item[idField] === id);
    const destination = index + delta;
    if (index < 0 || destination < 0 || destination >= list.length) return;
    [list[index], list[destination]] = [list[destination], list[index]];
  }

  function imagePath(publicUrl) {
    const marker = "/storage/v1/object/public/homepage-images/";
    const index = String(publicUrl || "").indexOf(marker);
    return index < 0 ? null : decodeURIComponent(publicUrl.slice(index + marker.length));
  }

  async function uploadImage(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPEG, PNG, or WebP image.");
    }
    if (file.size > 5 * 1024 * 1024) throw new Error("Images must be 5 MB or smaller.");
    const previewUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("The selected file is not a valid image."));
        image.src = previewUrl;
      });
    } finally {
      URL.revokeObjectURL(previewUrl);
    }
    const name = file.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "homepage-image";
    const path = `homepage/${crypto.randomUUID()}-${name}`;
    const { error } = await supabase.storage.from("homepage-images").upload(path, file, {
      cacheControl: "31536000",
      contentType: file.type,
      upsert: false,
    });
    if (error) throw error;
    return supabase.storage.from("homepage-images").getPublicUrl(path).data.publicUrl;
  }

  async function removeIfUnused(publicUrl) {
    const path = imagePath(publicUrl);
    if (!path) return true;
    const { data: inUse, error: usageError } = await supabase.rpc("homepage_image_is_in_use", {
      target_image_url: publicUrl,
    });
    if (usageError) throw usageError;
    if (inUse) return false;
    const { error } = await supabase.storage.from("homepage-images").remove([path]);
    if (error) throw error;
    return true;
  }

  async function cleanupImages() {
    const candidates = [...state.cleanupCandidates];
    for (const url of candidates) {
      try {
        if (await removeIfUnused(url)) state.cleanupCandidates.delete(url);
      } catch (error) {
        console.error("Beauty Pluz admin: could not remove an unused homepage image.", error);
        setMessage("Content saved, but an unused image could not be removed from storage.", true);
      }
    }
  }

  async function saveDraft() {
    if (state.saving) return false;
    state.saving = true;
    setMessage("");
    try {
      const session = await verifyAdminSession();
      if (!session) throw new Error("Administrator access is required. Sign in again.");
      const content = currentContent();
      validateContent(content);
      const { data, error } = await supabase.rpc("save_homepage_draft", { content });
      if (error) throw error;
      if (!data) throw new Error("The server did not confirm the saved draft.");
      state.draft = data;
      await cleanupImages();
      renderContent();
      setMessage("Draft saved. Visitors will continue to see the currently published homepage.");
      return true;
    } catch (error) {
      console.error("Beauty Pluz admin: could not save homepage draft.", error);
      setMessage(error.message || "Could not save the homepage draft.", true);
      return false;
    } finally {
      state.saving = false;
    }
  }

  async function publishDraft() {
    if (!(await saveDraft())) return;
    const confirmed = window.confirm("Publish these homepage changes for all visitors?");
    if (!confirmed) return;
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("publish_homepage_draft");
      if (error) throw error;
      state.published = data;
      state.lastPublishedAt = new Date().toISOString();
      await cleanupImages();
      renderContent();
      setMessage("Homepage changes published. They are now live for all visitors.");
    } catch (error) {
      console.error("Beauty Pluz admin: could not publish homepage content.", error);
      setMessage(error.message || "Could not publish homepage content.", true);
    }
  }

  function renderPreview() {
    const content = currentContent();
    const enabledSlides = content.slides.filter((slide) => slide.enabled);
    const selectedProducts = content.featuredProductIds
      .map((id) => state.products.find((product) => product.id === id))
      .filter(Boolean);
    const promotions = content.promotions.filter((promotion) => promotion.enabled);
    previewContent.innerHTML = `
      ${content.announcement.enabled && content.announcement.text
        ? `<div class="homepage-preview__announcement">${escapeHtml(content.announcement.text)}</div>`
        : ""}
      <h3 class="homepage-preview__section-label">Hero carousel · ${enabledSlides.length} enabled slides</h3>
      <div class="homepage-preview__slides">${enabledSlides.map((slide, index) => `
        <article class="homepage-preview__hero" data-preview-slide="${index}">
          <img src="${escapeHtml(slide.image ? storeAssetUrl(slide.image) : fallbackHeroImage)}" alt="" data-preview-image="${index}">
          <div class="homepage-preview__hero-copy">
            ${slide.eyebrow ? `<p>${escapeHtml(slide.eyebrow)}</p>` : ""}
            <h4>${escapeHtml(slide.heading || "Your slide heading")}</h4>
            <span>${escapeHtml(slide.description || "Your slide description")}</span>
            ${slide.ctaText ? `<b>${escapeHtml(slide.ctaText)} →</b>` : ""}
          </div>
        </article>
      `).join("")}</div>
      <h3 class="homepage-preview__section-label">Featured products</h3>
      <p>${selectedProducts.length ? selectedProducts.map((product) => escapeHtml(product.name)).join(" · ") : "No featured products selected."}</p>
      <h3 class="homepage-preview__section-label">Promotional banners</h3>
      ${promotions.length ? promotions.map((promotion) => `
        <article class="homepage-preview__promotion">
          ${promotion.image ? `<img src="${escapeHtml(storeAssetUrl(promotion.image))}" alt="" data-promo-preview-image>` : ""}
          <div><p>${escapeHtml(promotion.eyebrow)}</p><h4>${escapeHtml(promotion.heading)}</h4><span>${escapeHtml(promotion.description)}</span>${promotion.ctaText ? `<b>${escapeHtml(promotion.ctaText)}</b>` : ""}</div>
        </article>
      `).join("") : "<p>No promotional banners enabled.</p>"}
    `;
    previewContent.querySelectorAll("[data-preview-image]").forEach((image, index) => {
      image.addEventListener("error", () => {
      image.src = new URL(fallbackHeroImage, window.location.href).href;
      }, { once: true });
      const localPreview = state.uploadObjectUrls.get(`slide:${enabledSlides[index].id}`);
      if (localPreview) image.src = localPreview;
    });
    previewContent.querySelectorAll("[data-promo-preview-image]").forEach((image) => {
      image.addEventListener("error", () => image.remove(), { once: true });
    });
    previewDialog.showModal();
  }

  function addFieldListeners() {
    document.querySelector("[data-announcement-enabled]").addEventListener("change", () => {
      state.draft.announcement.enabled = document.querySelector("[data-announcement-enabled]").checked;
    });
    document.querySelector("[data-announcement-copy]").addEventListener("input", (event) => {
      state.draft.announcement.text = event.target.value;
    });

    slideList.addEventListener("input", (event) => {
      const field = event.target.closest("[data-slide-field]");
      if (!field) return;
      const slide = state.draft.slides.find((item) => item.id === field.dataset.slideId);
      if (slide) slide[field.dataset.slideField] = field.type === "checkbox" ? field.checked : field.value;
    });
    slideList.addEventListener("change", async (event) => {
      const field = event.target.closest("[data-slide-field]");
      if (field) {
        const slide = state.draft.slides.find((item) => item.id === field.dataset.slideId);
        if (slide) slide[field.dataset.slideField] = field.type === "checkbox" ? field.checked : field.value;
        return;
      }
      const input = event.target.closest("[data-slide-upload]");
      if (!input?.files?.[0]) return;
      const slide = state.draft.slides.find((item) => item.id === input.dataset.slideUpload);
      if (!slide) return;
      try {
        const uploadedUrl = await uploadImage(input.files[0]);
        setUploadPreview(`slide:${slide.id}`, input.files[0]);
        if (slide.image && slide.image !== uploadedUrl) state.cleanupCandidates.add(slide.image);
        slide.image = uploadedUrl;
        renderSlides();
        setMessage("Slide image uploaded. Save the draft to keep it; publish when ready.");
      } catch (error) {
        console.error("Beauty Pluz admin: hero image upload failed.", error);
        setMessage(error.message || "Could not upload slide image.", true);
      }
    });
    slideList.addEventListener("click", (event) => {
      const move = event.target.closest("[data-slide-move]");
      const remove = event.target.closest("[data-slide-delete]");
      const removeImage = event.target.closest("[data-slide-remove-image]");
      if (move) {
        moveItem(state.draft.slides, move.dataset.slideId, Number(move.dataset.slideMove));
        renderSlides();
      } else if (remove) {
        const [slide] = state.draft.slides.splice(state.draft.slides.findIndex((item) => item.id === remove.dataset.slideDelete), 1);
        if (slide?.image) state.cleanupCandidates.add(slide.image);
        clearUploadPreview(`slide:${remove.dataset.slideDelete}`);
        renderSlides();
      } else if (removeImage) {
        const slide = state.draft.slides.find((item) => item.id === removeImage.dataset.slideRemoveImage);
        if (slide?.image) state.cleanupCandidates.add(slide.image);
        if (slide) slide.image = "";
        clearUploadPreview(`slide:${removeImage.dataset.slideRemoveImage}`);
        renderSlides();
      }
    });

    featuredList.addEventListener("change", (event) => {
      const input = event.target.closest("[data-feature-toggle]");
      if (!input) return;
      if (input.checked) {
        if (state.draft.featuredProductIds.length >= 12) {
          input.checked = false;
          setMessage("Choose up to 12 featured products.", true);
          return;
        }
        state.draft.featuredProductIds.push(input.dataset.featureToggle);
      } else {
        state.draft.featuredProductIds = state.draft.featuredProductIds.filter((id) => id !== input.dataset.featureToggle);
      }
      renderFeaturedProducts();
    });
    featuredList.addEventListener("click", (event) => {
      const move = event.target.closest("[data-feature-move]");
      if (!move) return;
      moveItem(state.draft.featuredProductIds, move.dataset.productId, Number(move.dataset.featureMove), "");
      renderFeaturedProducts();
    });

    promotionList.addEventListener("input", (event) => {
      const field = event.target.closest("[data-promotion-field]");
      if (!field) return;
      const promotion = state.draft.promotions.find((item) => item.id === field.dataset.promotionId);
      if (promotion) promotion[field.dataset.promotionField] = field.type === "checkbox" ? field.checked : field.value;
    });
    promotionList.addEventListener("change", async (event) => {
      const field = event.target.closest("[data-promotion-field]");
      if (field) {
        const promotion = state.draft.promotions.find((item) => item.id === field.dataset.promotionId);
        if (promotion) promotion[field.dataset.promotionField] = field.type === "checkbox" ? field.checked : field.value;
        return;
      }
      const input = event.target.closest("[data-promotion-upload]");
      if (!input?.files?.[0]) return;
      const promotion = state.draft.promotions.find((item) => item.id === input.dataset.promotionUpload);
      if (!promotion) return;
      try {
        const uploadedUrl = await uploadImage(input.files[0]);
        setUploadPreview(`promotion:${promotion.id}`, input.files[0]);
        if (promotion.image && promotion.image !== uploadedUrl) state.cleanupCandidates.add(promotion.image);
        promotion.image = uploadedUrl;
        renderPromotions();
        setMessage("Banner image uploaded. Save the draft to keep it; publish when ready.");
      } catch (error) {
        console.error("Beauty Pluz admin: promotional image upload failed.", error);
        setMessage(error.message || "Could not upload banner image.", true);
      }
    });
    promotionList.addEventListener("click", (event) => {
      const move = event.target.closest("[data-promotion-move]");
      const remove = event.target.closest("[data-promotion-delete]");
      const removeImage = event.target.closest("[data-promotion-remove-image]");
      if (move) {
        moveItem(state.draft.promotions, move.dataset.promotionId, Number(move.dataset.promotionMove));
        renderPromotions();
      } else if (remove) {
        const [promotion] = state.draft.promotions.splice(state.draft.promotions.findIndex((item) => item.id === remove.dataset.promotionDelete), 1);
        if (promotion?.image) state.cleanupCandidates.add(promotion.image);
        clearUploadPreview(`promotion:${remove.dataset.promotionDelete}`);
        renderPromotions();
      } else if (removeImage) {
        const promotion = state.draft.promotions.find((item) => item.id === removeImage.dataset.promotionRemoveImage);
        if (promotion?.image) state.cleanupCandidates.add(promotion.image);
        if (promotion) promotion.image = "";
        clearUploadPreview(`promotion:${removeImage.dataset.promotionRemoveImage}`);
        renderPromotions();
      }
    });
  }

  async function initialize() {
    await loadContent();
    addFieldListeners();
    document.querySelector("[data-slide-add]").addEventListener("click", () => {
      if (state.draft.slides.length >= 20) {
        setMessage("You can add up to 20 hero slides.", true);
        return;
      }
      state.draft.slides.push(defaultSlide());
      renderSlides();
    });
    document.querySelector("[data-promotion-add]").addEventListener("click", () => {
      if (state.draft.promotions.length >= 10) {
        setMessage("You can add up to 10 promotional banners.", true);
        return;
      }
      state.draft.promotions.push(defaultPromotion());
      renderPromotions();
    });
    document.querySelector("[data-homepage-save]").addEventListener("click", saveDraft);
    document.querySelector("[data-homepage-publish]").addEventListener("click", publishDraft);
    document.querySelector("[data-homepage-preview]").addEventListener("click", () => {
      try {
        validateContent(currentContent());
        renderPreview();
      } catch (error) {
        setMessage(error.message, true);
      }
    });
    document.querySelector("[data-preview-close]").addEventListener("click", () => previewDialog.close());
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.replace("/admin/login.html");
    });
  }

  initialize().catch((error) => {
    console.error("Beauty Pluz admin: homepage content could not be initialized.", error);
    setMessage(error.message || "Could not load homepage content.", true);
  });
})();
