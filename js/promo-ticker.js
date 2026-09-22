/* =========================================================
   BEAUTY PLUZ — PROMO-TICKER.JS
   Renders the scrolling promotional marquee positioned directly
   below the sticky navigation. This is a different component from
   the dismissible, static #announcement-bar above the header —
   that one keeps its existing behaviour untouched; this one is a
   continuously-looping ticker with no dismiss control.

   EDIT THE MESSAGE HERE — this is the one place ticker copy lives.
   Everything else (the seamless loop, responsive sizing, reduced-
   motion handling) is driven from this single array.
   ========================================================= */

(function () {
  "use strict";

  const TICKER_ITEMS = [
    "Free shipping on orders over $75",
    "New products available now",
    // "Shop the Ritual Edit",
  ];

  /** Builds one <span class="promo-ticker__group"> containing every
      ticker item. Two of these are placed side by side in the track
      so the CSS animation can move exactly one group-width (-50%)
      and loop with no visible seam. */
  function buildGroupMarkup() {
    return TICKER_ITEMS.map(
      (text) => `<span class="promo-ticker__item">${text}</span>`
    ).join("");
  }

  function initPromoTicker() {
    const track = document.querySelector("[data-ticker-track]");
    if (!track) return;

    const groupMarkup = buildGroupMarkup();

    // Render as an accessible, single announcement (group 1) plus a
    // visually-identical, hidden-from-assistive-tech duplicate
    // (group 2) that exists purely to make the CSS loop seamless.
    track.innerHTML =
      `<span class="promo-ticker__group">${groupMarkup}</span>` +
      `<span class="promo-ticker__group" aria-hidden="true">${groupMarkup}</span>`;
  }

  document.addEventListener("DOMContentLoaded", initPromoTicker);
})();
