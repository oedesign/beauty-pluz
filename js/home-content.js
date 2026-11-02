import { publicSupabase } from "./public-supabase.js";
let contentRequest;

export function loadPublishedHomepageContent() {
  if (!publicSupabase) return Promise.resolve(null);
  if (!contentRequest) {
    contentRequest = publicSupabase.rpc("get_published_homepage_content").then(({ data, error }) => {
      if (error) throw error;
      return data;
    });
  }
  return contentRequest;
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

function safeLink(value, fallback = "shop.html") {
  const link = String(value || "").trim();
  if (!link || link.startsWith("//") || /^(javascript|data|vbscript):/i.test(link)) return fallback;
  try {
    const parsed = new URL(link, window.location.href);
    if (parsed.protocol !== "https:" && parsed.origin !== window.location.origin) return fallback;
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fallback;
    return link;
  } catch {
    return fallback;
  }
}

function renderAnnouncement(content) {
  const bar = document.querySelector("[data-announcement-bar]");
  const text = document.querySelector("[data-announcement-text]");
  const close = document.querySelector("[data-announcement-close]");
  const announcement = content?.announcement;
  if (!bar || !text || !announcement?.enabled || !announcement.text?.trim()) return;

  const dismissed = sessionStorage.getItem("beautypluzAnnouncementDismissed") === "true";
  if (dismissed) return;

  text.textContent = announcement.text.trim();
  bar.hidden = false;
  close?.addEventListener("click", () => {
    bar.classList.add("is-dismissed");
    sessionStorage.setItem("beautypluzAnnouncementDismissed", "true");
  });
}

function renderPromotions(content) {
  const root = document.querySelector("[data-home-promotions]");
  if (!root) return;
  const promotions = (content?.promotions || []).filter((promotion) => promotion.enabled);
  root.innerHTML = promotions.map((promotion, index) => `
    <section class="promo-banner${promotion.image ? " promo-banner--with-image" : ""}" aria-labelledby="promo-banner-heading-${index}">
      ${promotion.image ? `<img class="promo-banner__image" src="${escapeHtml(promotion.image)}" alt="" loading="lazy">` : ""}
      <div class="promo-banner__shape promo-banner__shape--one" aria-hidden="true"></div>
      <div class="promo-banner__shape promo-banner__shape--two" aria-hidden="true"></div>
      <div class="container promo-banner__inner reveal">
        ${promotion.eyebrow ? `<span class="eyebrow eyebrow--on-dark">${escapeHtml(promotion.eyebrow)}</span>` : ""}
        <h2 id="promo-banner-heading-${index}">${escapeHtml(promotion.heading)}</h2>
        ${promotion.description ? `<p>${escapeHtml(promotion.description)}</p>` : ""}
        <div class="promo-banner__actions">
          ${promotion.code ? `<code class="promo-banner__code">${escapeHtml(promotion.code)}</code>` : ""}
          ${promotion.ctaText ? `<a href="${escapeHtml(safeLink(promotion.ctaLink))}" class="btn btn--light">${escapeHtml(promotion.ctaText)}</a>` : ""}
        </div>
      </div>
    </section>
  `).join("");
  root.querySelectorAll(".promo-banner__image").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
}

async function renderFeaturedProducts(content) {
  const grid = document.querySelector('[data-home-products="featured"]');
  const products = window.BeautyPluzProducts;
  if (!grid || !products || !Array.isArray(content?.featuredProductIds)) return;
  await products.ready;
  const orderedProducts = content.featuredProductIds
    .map((id) => products.getById(id))
    .filter((product) => product && product.is_published && product.is_available && product.stock_quantity !== 0);
  products.renderCards(grid, orderedProducts);
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const content = await loadPublishedHomepageContent();
    if (!content) return;
    renderAnnouncement(content);
    renderPromotions(content);
    await renderFeaturedProducts(content);
  } catch (error) {
    console.error("Beauty Pluz: could not load published homepage content.", error);
  }
});
