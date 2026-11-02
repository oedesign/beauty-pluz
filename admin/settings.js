import { supabase, verifyAdminSession } from "./client.js";

(() => {
  "use strict";

  const DEFAULT_LOGO = "../images/beautypluz-logo.webp";
  const form = document.querySelector("[data-settings-form]");
  const status = document.querySelector("[data-settings-status]");
  const promoList = document.querySelector("[data-settings-promo-list]");
  const linkList = document.querySelector("[data-settings-link-list]");
  const logoPreview = document.querySelector("[data-settings-logo-preview]");
  const state = { settings: null, originalLogo: "", uploadedPath: null, previewUrl: null, saving: false };
  const DEFAULT_BUSINESS_HOURS = "Monday – Friday: 9am – 6pm\nSaturday: 10am – 4pm\nSunday: Closed";
  const DEFAULT_BUSINESS_ADDRESS = "Unit 53, 140a Queensway, Bletchley Milton Keynes, MK2 2AA";

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

  function newPromo() {
    return { id: `promo-${crypto.randomUUID()}`, message: "", code: "" };
  }

  function newLink() {
    return { id: `footer-${crypto.randomUUID()}`, label: "", url: "" };
  }

  function assetUrl(value) {
    const path = String(value || "");
    if (/^https:\/\//i.test(path)) return path;
    return new URL(path.replace(/^\/+/, ""), `${window.location.origin}/`).href;
  }

  function setLogoPreview(source) {
    logoPreview.src = source
      ? (String(source).startsWith("blob:") ? source : assetUrl(source))
      : DEFAULT_LOGO;
    logoPreview.onerror = () => {
      logoPreview.onerror = null;
      logoPreview.src = DEFAULT_LOGO;
    };
  }

  function renderPromos() {
    promoList.innerHTML = state.settings.promotionalMessages.map((promo, index) => `
      <article class="settings-list-card" data-settings-promo-card="${escapeHtml(promo.id)}">
        <header class="homepage-editor-card__header">
          <span class="homepage-editor-card__number">Message ${index + 1}</span>
          <button class="product-table__action product-table__action--delete" type="button" data-settings-delete-promo="${escapeHtml(promo.id)}">Remove</button>
        </header>
        <div class="settings-fields settings-fields--two">
          <label class="product-form__field"><span>Ticker message</span><input data-settings-promo-field="message" data-settings-promo-id="${escapeHtml(promo.id)}" maxlength="180" required value="${escapeHtml(promo.message)}"></label>
          <label class="product-form__field"><span>Discount code (display only)</span><input data-settings-promo-field="code" data-settings-promo-id="${escapeHtml(promo.id)}" maxlength="40" value="${escapeHtml(promo.code)}" placeholder="Optional"></label>
        </div>
      </article>
    `).join("");
    if (!state.settings.promotionalMessages.length) {
      promoList.innerHTML = '<p class="homepage-panel__hint">No promotional messages. Add a message to show the storefront ticker.</p>';
    }
  }

  function renderLinks() {
    linkList.innerHTML = state.settings.footerLinks.map((link, index) => `
      <article class="settings-list-card" data-settings-link-card="${escapeHtml(link.id)}">
        <header class="homepage-editor-card__header">
          <span class="homepage-editor-card__number">Footer link ${index + 1}</span>
          <button class="product-table__action product-table__action--delete" type="button" data-settings-delete-link="${escapeHtml(link.id)}">Remove</button>
        </header>
        <div class="settings-fields settings-fields--two">
          <label class="product-form__field"><span>Link label</span><input data-settings-link-field="label" data-settings-link-id="${escapeHtml(link.id)}" maxlength="80" required value="${escapeHtml(link.label)}"></label>
          <label class="product-form__field"><span>Page URL (site path or https://)</span><input data-settings-link-field="url" data-settings-link-id="${escapeHtml(link.id)}" maxlength="500" required value="${escapeHtml(link.url)}" placeholder="contact.html"></label>
        </div>
      </article>
    `).join("");
    if (!state.settings.footerLinks.length) {
      linkList.innerHTML = '<p class="homepage-panel__hint">No custom footer links. Existing Shop and Company navigation is unchanged.</p>';
    }
  }

  function renderSettings() {
    const settings = state.settings;
    form.elements.namedItem("storeName").value = settings.storeName || "";
    form.elements.namedItem("logo").value = settings.logo || "";
    form.elements.namedItem("email").value = settings.contact?.email || "";
    form.elements.namedItem("phone").value = settings.contact?.phone || "";
    form.elements.namedItem("whatsapp").value = settings.contact?.whatsapp || "";
    form.elements.namedItem("businessHours").value = settings.contact?.businessHours || DEFAULT_BUSINESS_HOURS;
    form.elements.namedItem("address").value = settings.contact?.address || DEFAULT_BUSINESS_ADDRESS;
    form.elements.namedItem("instagram").value = settings.social?.instagram || "";
    form.elements.namedItem("facebook").value = settings.social?.facebook || "";
    form.elements.namedItem("tiktok").value = settings.social?.tiktok || "";
    form.elements.namedItem("youtube").value = settings.social?.youtube || "";
    form.elements.namedItem("x").value = settings.social?.x || "";
    form.elements.namedItem("shippingInfo").value = settings.shippingInfo || "";
    form.elements.namedItem("footerDescription").value = settings.footerDescription || "";
    form.elements.namedItem("currency").value = "GBP";
    state.originalLogo = settings.logo || "";
    setLogoPreview(state.previewUrl || settings.logo);
    renderPromos();
    renderLinks();
  }

  function normalizePhone(value, label, required = false) {
    const phone = String(value || "").trim();
    if (required && !phone) throw new Error(`${label} is required.`);
    if (phone && !/^\+?[0-9 ()-]{6,40}$/.test(phone)) {
      throw new Error(`${label} must contain only digits, spaces, parentheses, hyphens, and an optional leading +.`);
    }
    return phone;
  }

  function validateUrl(value, label, { required = false, httpsOnly = false } = {}) {
    const url = String(value || "").trim();
    if (required && !url) throw new Error(`${label} is required.`);
    if (!url) return "";
    if (url.startsWith("//") || /^(javascript|data|vbscript):/i.test(url) || /\s/.test(url)) {
      throw new Error(`${label} must be a safe site path or secure https:// link.`);
    }
    let parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      throw new Error(`${label} is not a valid URL.`);
    }
    if (parsed.protocol !== "https:" && !(parsed.origin === window.location.origin && parsed.protocol === "http:")) {
      throw new Error(`${label} must use https:// or a same-site path.`);
    }
    if (httpsOnly && parsed.protocol !== "https:") {
      throw new Error(`${label} must use https://.`);
    }
    return url;
  }

  function getSettingsFromForm() {
    const current = state.settings;
    const email = form.elements.namedItem("email").value.trim();
    if (email && !form.elements.namedItem("email").checkValidity()) {
      throw new Error("Enter a valid customer email address.");
    }

    const name = form.elements.namedItem("storeName").value.trim();
    if (!name || name.length > 100) throw new Error("Store name is required and must be at most 100 characters.");
    const footerDescription = form.elements.namedItem("footerDescription").value.trim();
    if (footerDescription.length > 500) throw new Error("Footer description must be 500 characters or fewer.");
    const shippingInfo = form.elements.namedItem("shippingInfo").value.trim();
    if (shippingInfo.length > 2000) throw new Error("Shipping information must be 2,000 characters or fewer.");

    const promotionalMessages = current.promotionalMessages.map((promo, index) => {
      const message = String(promo.message || "").trim();
      const code = String(promo.code || "").trim();
      if (!message || message.length > 180) throw new Error(`Promotional message ${index + 1} is required and must be at most 180 characters.`);
      if (code.length > 40) throw new Error(`Discount code ${index + 1} must be at most 40 characters.`);
      return { id: promo.id, message, code };
    });
    const footerLinks = current.footerLinks.map((link, index) => {
      const label = String(link.label || "").trim();
      if (!label || label.length > 80) throw new Error(`Footer link ${index + 1} needs a label of at most 80 characters.`);
      if (String(link.url || "").length > 500) throw new Error(`Footer link ${index + 1} URL must be at most 500 characters.`);
      return {
        id: link.id,
        label,
        url: validateUrl(link.url, `Footer link ${index + 1} URL`, { required: true }),
      };
    });

    return {
      storeName: name,
      logo: String(form.elements.namedItem("logo").value || ""),
      contact: {
        email,
        phone: normalizePhone(form.elements.namedItem("phone").value, "Phone number"),
        whatsapp: normalizePhone(form.elements.namedItem("whatsapp").value, "WhatsApp number"),
        businessHours: form.elements.namedItem("businessHours").value.trim(),
        address: form.elements.namedItem("address").value.trim(),
      },
      social: {
        instagram: validateUrl(form.elements.namedItem("instagram").value, "Instagram URL", { httpsOnly: true }),
        facebook: validateUrl(form.elements.namedItem("facebook").value, "Facebook URL", { httpsOnly: true }),
        tiktok: validateUrl(form.elements.namedItem("tiktok").value, "TikTok URL", { httpsOnly: true }),
        youtube: validateUrl(form.elements.namedItem("youtube").value, "YouTube URL", { httpsOnly: true }),
        x: validateUrl(form.elements.namedItem("x").value, "X URL", { httpsOnly: true }),
      },
      shippingInfo,
      promotionalMessages,
      footerDescription,
      footerLinks,
      currency: "GBP",
    };
  }

  async function uploadLogo(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPEG, PNG, or WebP image.");
    }
    if (file.size > 2 * 1024 * 1024) throw new Error("The logo image must be 2 MB or smaller.");
    const previewUrl = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = resolve;
        image.onerror = () => reject(new Error("The selected file is not a valid image."));
        image.src = previewUrl;
      });
    } finally {
      URL.revokeObjectURL(previewUrl);
    }
    const filename = file.name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9.-]+/g, "-") || "store-logo";
    const path = `branding/${crypto.randomUUID()}-${filename}`;
    const { error } = await supabase.storage.from("store-assets").upload(path, file, {
      cacheControl: "31536000",
      contentType: file.type,
      upsert: false,
    });
    if (error) throw error;
    return {
      url: supabase.storage.from("store-assets").getPublicUrl(path).data.publicUrl,
      path,
    };
  }

  async function removePreviousLogo() {
    const previous = state.originalLogo;
    if (!previous || previous === form.elements.namedItem("logo").value) return true;
    const marker = "/storage/v1/object/public/store-assets/";
    const markerIndex = previous.indexOf(marker);
    if (markerIndex < 0) return true;
    const path = decodeURIComponent(previous.slice(markerIndex + marker.length));
    const { error } = await supabase.storage.from("store-assets").remove([path]);
    if (error) {
      console.error("Beauty Pluz admin: saved settings, but the previous logo could not be removed.", error);
      return false;
    }
    state.originalLogo = form.elements.namedItem("logo").value;
    return true;
  }

  function bindEvents() {
    form.addEventListener("input", (event) => {
      const promoField = event.target.closest("[data-settings-promo-field]");
      if (promoField) {
        const promo = state.settings.promotionalMessages.find((item) => item.id === promoField.dataset.settingsPromoId);
        if (promo) promo[promoField.dataset.settingsPromoField] = promoField.value;
      }
      const linkField = event.target.closest("[data-settings-link-field]");
      if (linkField) {
        const link = state.settings.footerLinks.find((item) => item.id === linkField.dataset.settingsLinkId);
        if (link) link[linkField.dataset.settingsLinkField] = linkField.value;
      }
    });

    promoList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-settings-delete-promo]");
      if (!button) return;
      if (!window.confirm("Remove this promotional ticker message? The code is display-only and will no longer appear in the ticker.")) return;
      state.settings.promotionalMessages = state.settings.promotionalMessages.filter((item) => item.id !== button.dataset.settingsDeletePromo);
      renderPromos();
    });
    linkList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-settings-delete-link]");
      if (!button) return;
      if (!window.confirm("Remove this footer link from the storefront?")) return;
      state.settings.footerLinks = state.settings.footerLinks.filter((item) => item.id !== button.dataset.settingsDeleteLink);
      renderLinks();
    });

    document.querySelector("[data-settings-add-promo]").addEventListener("click", () => {
      if (state.settings.promotionalMessages.length >= 10) {
        setMessage("You can add up to 10 ticker messages.", true);
        return;
      }
      state.settings.promotionalMessages.push(newPromo());
      renderPromos();
    });
    document.querySelector("[data-settings-add-link]").addEventListener("click", () => {
      if (state.settings.footerLinks.length >= 12) {
        setMessage("You can add up to 12 custom footer links.", true);
        return;
      }
      state.settings.footerLinks.push(newLink());
      renderLinks();
    });

    form.elements.namedItem("logoFile").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setMessage("");
      try {
        const image = await uploadLogo(file);
        if (state.uploadedPath) {
          const previousUploadPath = state.uploadedPath;
          const { error } = await supabase.storage.from("store-assets").remove([previousUploadPath]);
          if (error) {
            const { error: cleanupError } = await supabase.storage.from("store-assets").remove([image.path]);
            if (cleanupError) console.error("Beauty Pluz admin: could not clean up an unselected logo upload.", cleanupError);
            throw error;
          }
        }
        state.uploadedPath = image.path;
        form.elements.namedItem("logo").value = image.url;
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = URL.createObjectURL(file);
        setLogoPreview(state.previewUrl);
      } catch (error) {
        console.error("Beauty Pluz admin: logo upload failed.", error);
        setMessage(error.message || "Could not upload logo.", true);
        event.target.value = "";
      }
    });

    document.querySelector("[data-settings-remove-logo]").addEventListener("click", async () => {
      if (!window.confirm("Restore the original Beauty Pluz logo on the storefront? The current uploaded logo will be removed after you save.")) return;
      if (state.uploadedPath) {
        const { error } = await supabase.storage.from("store-assets").remove([state.uploadedPath]);
        if (error) {
          console.error("Beauty Pluz admin: abandoned logo upload could not be removed.", error);
          setMessage(error.message || "Could not remove the uploaded logo.", true);
          return;
        }
        state.uploadedPath = null;
      }
      if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
      form.elements.namedItem("logo").value = "images/beautypluz-logo.webp";
      form.elements.namedItem("logoFile").value = "";
      setLogoPreview(form.elements.namedItem("logo").value);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.saving) return;
      setMessage("");
      let settings;
      try {
        settings = getSettingsFromForm();
      } catch (error) {
        setMessage(error.message, true);
        return;
      }
      if (settings.logo !== state.originalLogo
          && !window.confirm("Save this logo change and remove the previous uploaded logo if it is no longer used?")) {
        return;
      }
      state.saving = true;
      const saveButton = document.querySelector("[data-settings-save]");
      saveButton.disabled = true;
      try {
        if (!(await verifyAdminSession())) throw new Error("Administrator access expired. Sign in again.");
        const { data, error } = await supabase.rpc("save_store_settings", { settings });
        if (error) throw error;
        if (!data) throw new Error("The server did not confirm the settings update.");
        state.settings = data;
        const previousLogoRemoved = await removePreviousLogo();
        state.originalLogo = data.logo || "";
        state.uploadedPath = null;
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = null;
        renderSettings();
        setMessage(previousLogoRemoved
          ? "Store settings saved and published. Public pages show the changes on their next load."
          : "Settings were saved and published, but the previous uploaded logo could not be removed from storage.", !previousLogoRemoved);
      } catch (error) {
        console.error("Beauty Pluz admin: settings save failed.", error);
        setMessage(error.message || "Could not save store settings.", true);
      } finally {
        state.saving = false;
        saveButton.disabled = false;
      }
    });

    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.replace("/admin/login.html");
    });
  }

  async function initialize() {
    const session = await verifyAdminSession();
    if (!session) {
      window.location.replace("/admin/login.html?reason=unauthorized");
      return;
    }
    const { data, error } = await supabase.rpc("get_admin_store_settings");
    if (error) throw error;
    if (!data) throw new Error("Store settings are not initialized. Apply the store settings migration.");
    state.settings = data;
    renderSettings();
    bindEvents();
  }

  initialize().catch((error) => {
    console.error("Beauty Pluz admin: store settings could not be initialized.", error);
    setMessage(error.message || "Could not load store settings.", true);
  });
})();
