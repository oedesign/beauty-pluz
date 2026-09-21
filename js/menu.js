/* =========================================================
   BEAUTY PLUZ — MENU.JS
   Premium responsive navigation behaviour:
   1) Mobile drawer — hamburger↔X morph, right-side slide-in
      drawer, dark overlay, body scroll lock, and three ways
      to close (overlay click, toggle click, nav link click).
   2) Search panel — a slim reveal under the header, opened
      from the search icon.

   Markup contract (see index.html etc.):
   <button class="nav-toggle" aria-expanded="false" aria-controls="primary-nav">
   <nav id="primary-nav" class="nav-primary">…</nav>
   <div class="nav-overlay"></div>
   <button id="search-toggle" aria-expanded="false" aria-controls="search-panel">
   <div id="search-panel" class="search-panel">…</div>
   ========================================================= */

(function () {
  "use strict";

  /* -----------------------------
     Mobile navigation drawer
  ------------------------------ */
  function initMobileMenu() {
    const toggle = document.querySelector(".nav-toggle");
    const nav = document.querySelector(".nav-primary");
    const overlay = document.querySelector(".nav-overlay");
    const header = document.querySelector(".site-header");

    if (!toggle || !nav) return;

    const isOpen = () => nav.classList.contains("is-open");

    // --- Background scroll lock -------------------------------------
    // overflow:hidden on body alone does not reliably block scrolling
    // on iOS Safari (touch/rubber-band scrolling can still move the
    // page underneath). The standard cross-browser fix is to pin the
    // body at its current scroll offset with position:fixed, then
    // restore that exact offset when unlocking.
    const lockBodyScroll = () => {
      const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
      document.body.dataset.scrollLockY = String(scrollY);
      document.body.style.top = `-${scrollY}px`;
      document.body.classList.add("no-scroll");
    };

    const unlockBodyScroll = () => {
      const scrollY = parseInt(document.body.dataset.scrollLockY || "0", 10);
      document.body.classList.remove("no-scroll");
      document.body.style.top = "";
      delete document.body.dataset.scrollLockY;
      // Restore the exact position instantly — bypass the site's
      // global smooth-scroll behavior, which would otherwise animate
      // this jump.
      window.scrollTo({ top: scrollY, left: 0, behavior: "auto" });
    };

    const openMenu = () => {
      nav.classList.add("is-open");
      overlay?.classList.add("is-open");
      header?.classList.add("is-menu-open");
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "Close menu");
      lockBodyScroll();
    };

    const closeMenu = () => {
      nav.classList.remove("is-open");
      overlay?.classList.remove("is-open");
      header?.classList.remove("is-menu-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open menu");
      unlockBodyScroll();
    };

    toggle.addEventListener("click", () => {
      isOpen() ? closeMenu() : openMenu();
    });

    // Close on overlay click
    overlay?.addEventListener("click", closeMenu);

    // Close when any nav link is chosen
    nav.addEventListener("click", (event) => {
      if (event.target.tagName === "A") closeMenu();
    });

    // Close on Escape, return focus to the toggle
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen()) {
        closeMenu();
        toggle.focus();
      }
    });

    // Reset state if the viewport grows into the desktop layout
    const handleResize = window.BeautyPluz
      ? window.BeautyPluz.debounce(() => {
          if (window.innerWidth >= 1024 && isOpen()) closeMenu();
        }, 150)
      : () => {
          if (window.innerWidth >= 1024 && isOpen()) closeMenu();
        };

    window.addEventListener("resize", handleResize);
  }

  /* -----------------------------
     Search panel
  ------------------------------ */
  function initSearchPanel() {
    const toggle = document.querySelector("#search-toggle");
    const panel = document.querySelector("#search-panel");

    if (!toggle || !panel) return;

    const input = panel.querySelector("input[type='search']");
    const isOpen = () => panel.classList.contains("is-open");

    const openPanel = () => {
      panel.classList.add("is-open");
      toggle.setAttribute("aria-expanded", "true");
      // Wait for the reveal transition before focusing, so the
      // page doesn't jump while the panel is still animating in.
      window.setTimeout(() => input && input.focus(), 200);
    };

    const closePanel = () => {
      panel.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    };

    toggle.addEventListener("click", () => {
      isOpen() ? closePanel() : openPanel();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen()) {
        closePanel();
        toggle.focus();
      }
    });

    document.addEventListener("click", (event) => {
      if (!isOpen()) return;
      const clickedInsidePanel = panel.contains(event.target);
      const clickedToggle = toggle.contains(event.target);
      if (!clickedInsidePanel && !clickedToggle) closePanel();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMobileMenu();
    initSearchPanel();
  });
})();
