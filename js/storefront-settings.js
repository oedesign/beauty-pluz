import { publicSupabase } from "./public-supabase.js";
let settingsRequest;

export function loadPublishedStoreSettings() {
  if (!publicSupabase) return Promise.resolve(null);
  if (!settingsRequest) {
    settingsRequest = publicSupabase.rpc("get_published_store_settings").then(({ data, error }) => {
      if (error) throw error;
      return data;
    });
  }
  return settingsRequest;
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

function safeUrl(value, { secureOnly = false } = {}) {
  const url = String(value || "").trim();
  if (!url || url.startsWith("//") || /^(javascript|data|vbscript):/i.test(url) || /\s/.test(url)) return "";
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.protocol === "https:") return url;
    if (!secureOnly && parsed.protocol === "http:" && parsed.origin === window.location.origin) return url;
  } catch {
    return "";
  }
  return "";
}

function whatsappUrl(number) {
  const digits = String(number || "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? `https://wa.me/${digits}` : "";
}

function updateIdentity(settings) {
  const name = String(settings.storeName || "").trim();
  if (!name) return;
  document.querySelectorAll(".logo img").forEach((image) => {
    const logo = settings.logo ? safeUrl(settings.logo) : "";
    if (!logo) return;
    image.src = logo;
    image.alt = `${name} logo`;
  });
  document.querySelectorAll(".footer-brand__logo").forEach((element) => {
    element.textContent = name;
  });
  document.querySelectorAll("[data-current-year]").forEach((year) => {
    const paragraph = year.closest("p");
    if (!paragraph) return;
    paragraph.replaceChildren(
      document.createTextNode("© "),
      Object.assign(document.createElement("span"), { textContent: String(new Date().getFullYear()) }),
      document.createTextNode(` ${name}. All rights reserved.`),
    );
  });
  if (document.title.includes("Beauty Pluz")) {
    document.title = document.title.replace("Beauty Pluz", name);
  }
}

function updateContact(settings) {
  const contact = settings.contact || {};
  window.BEAUTY_PLUZ_WHATSAPP_NUMBER = String(contact.whatsapp || "");
  const phone = String(contact.phone || "").trim();
  const phoneHref = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "";
  document.querySelectorAll('a[href^="tel:"]').forEach((link) => {
    if (!phoneHref) {
      link.hidden = true;
      return;
    }
    link.href = phoneHref;
    if (link.textContent.trim()) link.textContent = phone;
  });

  const email = String(contact.email || "").trim();
  document.querySelectorAll('a[href^="mailto:"]').forEach((link) => {
    if (!email) {
      link.hidden = true;
      return;
    }
    link.href = `mailto:${email}`;
    if (link.textContent.trim()) link.textContent = email;
  });

  const wa = whatsappUrl(contact.whatsapp);
  document.querySelectorAll('a[href*="wa.me/"]').forEach((link) => {
    if (!wa) {
      link.hidden = true;
      return;
    }
    link.href = wa;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (link.closest(".contact-card")) link.textContent = contact.whatsapp;
  });

  const contactCards = [...document.querySelectorAll(".contact-card")];
  const businessHoursCard = contactCards.find((card) => card.querySelector("h3")?.textContent.trim() === "Business Hours");
  if (businessHoursCard && typeof contact.businessHours === "string") {
    const content = businessHoursCard.querySelector("p");
    if (content) {
      content.textContent = contact.businessHours;
      content.style.whiteSpace = "pre-line";
    }
  }
  const addressCard = contactCards.find((card) => card.querySelector("h3")?.textContent.trim() === "Business Location");
  if (addressCard && typeof contact.address === "string") {
    const content = addressCard.querySelector("p");
    if (content) content.textContent = contact.address;
  }
}

function updateSocial(settings) {
  const socials = settings.social || {};
  const platforms = [
    ["instagram", "Instagram", /instagram/i],
    ["facebook", "Facebook", /facebook/i],
    ["tiktok", "TikTok", /tiktok/i],
    ["youtube", "YouTube", /youtube/i],
    ["x", "X", /twitter|\bon x\b/i],
  ];
  const socialRoots = document.querySelectorAll(".footer-social");
  const existing = [...document.querySelectorAll(".footer-social__link")];
  platforms.forEach(([key, label, pattern]) => {
    const url = safeUrl(socials[key], { secureOnly: true });
    let link = existing.find((element) => element.dataset.storeSocial === key
      || pattern.test(`${element.getAttribute("aria-label") || ""} ${element.href || ""}`));
    if (!link && url && socialRoots.length) {
      link = document.createElement("a");
      link.className = "footer-social__link";
      link.dataset.storeSocial = key;
      link.setAttribute("aria-label", `${settings.storeName || "Store"} on ${label}`);
      link.textContent = label;
      socialRoots.forEach((root) => root.append(link.cloneNode(true)));
      link = socialRoots[0].lastElementChild;
      existing.push(link);
    }
    if (!link) return;
    link.hidden = !url;
    if (url) {
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  });
}

function updateFooter(settings) {
  document.querySelectorAll(".footer-brand__text").forEach((element) => {
    element.textContent = settings.footerDescription || "";
  });
  const root = document.querySelector(".footer-legal");
  if (!root || !Array.isArray(settings.footerLinks)) return;
  root.innerHTML = settings.footerLinks.map((link) => {
    const url = safeUrl(link.url);
    if (!url) return "";
    return `<li><a href="${escapeHtml(url)}">${escapeHtml(link.label)}</a></li>`;
  }).join("");
}

function updateShippingInfo(settings) {
  const target = document.querySelector("[data-store-shipping]");
  if (!target) return;
  const copy = String(settings.shippingInfo || "").trim();
  if (!copy) return;
  target.querySelector("[data-store-shipping-copy]").textContent = copy;
  target.hidden = false;
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const settings = await loadPublishedStoreSettings();
    if (!settings) return;
    updateIdentity(settings);
    updateContact(settings);
    updateSocial(settings);
    updateFooter(settings);
    updateShippingInfo(settings);
  } catch (error) {
    console.error("Beauty Pluz: could not load published store settings.", error);
  }
});
