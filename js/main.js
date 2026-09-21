/* =========================================================
   BEAUTY PLUZ — MAIN.JS
   Global, site-wide behaviour that every page needs:
   sticky header state, scroll-reveal animation trigger,
   current-year footer stamp, and shared helper utilities.
   Page-specific logic lives in menu.js, cart.js, products.js.
   ========================================================= */

(function () {
  "use strict";

  /**
   * Shared helpers namespaced under window.BeautyPluz so other
   * scripts (menu.js, cart.js, products.js) can reuse them
   * without polluting the global scope with loose functions.
   */
  const BeautyPluz = {
    /** Simple querySelector shorthand */
    qs(selector, scope) {
      return (scope || document).querySelector(selector);
    },

    /** Simple querySelectorAll shorthand, returns a real array */
    qsa(selector, scope) {
      return Array.from((scope || document).querySelectorAll(selector));
    },

    /** Format a number as currency. Adjust currency/locale as needed. */
    formatCurrency(amount, currency, locale) {
      const value = Number(amount) || 0;
      return new Intl.NumberFormat(locale || "en-US", {
        style: "currency",
        currency: currency || "USD",
      }).format(value);
    },

    /** Debounce helper for scroll/resize listeners */
    debounce(fn, wait) {
      let timeoutId;
      return function debounced(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn.apply(this, args), wait || 150);
      };
    },

    /**
     * Shows a brief toast notification at the bottom of the screen.
     * Reuses a single toast element across calls; re-triggering while
     * one is already visible resets its message and timer rather than
     * stacking multiple toasts.
     */
    showToast(message, duration) {
      let toast = document.querySelector(".toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.className = "toast";
        toast.setAttribute("role", "status");
        toast.setAttribute("aria-live", "polite");
        toast.innerHTML =
          '<span class="toast__icon" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M20 6 9 17l-5-5"></path></svg></span>' +
          '<span class="toast__text"></span>';
        document.body.appendChild(toast);
      }

      toast.querySelector(".toast__text").textContent = message;

      // Force a reflow so re-triggering the animation works even if
      // the toast is already visible (e.g. rapid repeated add-to-cart).
      toast.classList.remove("is-visible");
      void toast.offsetWidth;
      toast.classList.add("is-visible");

      window.clearTimeout(toast._hideTimeoutId);
      toast._hideTimeoutId = window.setTimeout(() => {
        toast.classList.remove("is-visible");
      }, duration || 2400);
    },
  };

  window.BeautyPluz = BeautyPluz;

  /* -----------------------------
     Sticky header — add a class once the page has scrolled
     so header.css can style the "condensed" scrolled state.
  ------------------------------ */
  function initHeaderScrollState() {
    const header = BeautyPluz.qs(".site-header");
    if (!header) return;

    const setState = () => {
      header.classList.toggle("is-scrolled", window.scrollY > 12);
    };

    setState();
    window.addEventListener("scroll", BeautyPluz.debounce(setState, 50));
  }

  /* -----------------------------
     Scroll-reveal — toggles .is-visible on elements carrying
     .reveal / .reveal-stagger (see animations.css) as they
     enter the viewport.
  ------------------------------ */
  function initScrollReveal() {
    const targets = BeautyPluz.qsa(".reveal, .reveal-stagger");
    if (!targets.length) return;

    if (!("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );

    targets.forEach((el) => observer.observe(el));
  }

  /* -----------------------------
     Footer year stamp — keeps © year current without a build step.
     Expects an element with [data-current-year] in the footer.
  ------------------------------ */
  function initFooterYear() {
    const yearEl = BeautyPluz.qs("[data-current-year]");
    if (yearEl) {
      yearEl.textContent = new Date().getFullYear();
    }
  }

  /* -----------------------------
     Newsletter form — client-side only (no backend yet).
     Validates the email, shows a status message, and resets
     the field on success. Swap the fetch() call in for a real
     subscribe endpoint when one exists.
  ------------------------------ */
  function initNewsletterForm() {
    const form = BeautyPluz.qs("#newsletter-form");
    const status = BeautyPluz.qs("#newsletter-status");
    if (!form || !status) return;

    const emailInput = form.querySelector("input[type='email']");

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const email = (emailInput?.value || "").trim();
      const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!isValid) {
        status.textContent = "Please enter a valid email address.";
        status.classList.add("is-error");
        emailInput?.focus();
        return;
      }

      // Placeholder for a real subscribe request:
      // fetch("/api/newsletter", { method: "POST", body: JSON.stringify({ email }) });

      status.classList.remove("is-error");
      status.textContent = "You're on the list — welcome to the ritual.";
      form.reset();
    });
  }

  /* -----------------------------
     Back to top — shows the button once the person has scrolled
     past the hero, scrolls smoothly on click (falls back to an
     instant jump if the person prefers reduced motion).
  ------------------------------ */
  function initBackToTop() {
    const button = BeautyPluz.qs("#back-to-top");
    if (!button) return;

    const setVisibility = () => {
      button.classList.toggle("is-visible", window.scrollY > 480);
    };

    setVisibility();
    window.addEventListener("scroll", BeautyPluz.debounce(setVisibility, 100));

    button.addEventListener("click", () => {
      const prefersReducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion ? "auto" : "smooth",
      });
    });
  }

  /* -----------------------------
     Announcement bar — dismissible, remembers the choice in
     localStorage so it stays closed across pages/visits.
  ------------------------------ */
  function initAnnouncementBar() {
    const STORAGE_KEY = "beautyPluzAnnouncementDismissed";
    const bar = BeautyPluz.qs("#announcement-bar");
    if (!bar) return;

    let dismissed = false;
    try {
      dismissed = localStorage.getItem(STORAGE_KEY) === "true";
    } catch (err) {
      // localStorage unavailable (private browsing, etc.) — bar just stays visible
    }

    if (dismissed) {
      bar.classList.add("is-dismissed");
      return;
    }

    const closeBtn = BeautyPluz.qs(".announcement-bar__close", bar);
    closeBtn?.addEventListener("click", () => {
      bar.classList.add("is-dismissed");
      try {
        localStorage.setItem(STORAGE_KEY, "true");
      } catch (err) {
        // ignore — worst case it reappears next visit
      }
    });
  }

  /* -----------------------------
     Contact form — validates required fields (email is optional
     but must be valid if given), then builds a formatted WhatsApp
     message from the values instead of submitting anywhere.
  ------------------------------ */
  function initContactForm() {
    const form = BeautyPluz.qs("#contact-form");
    if (!form) return;

    const WHATSAPP_NUMBER = "10000000000"; // same number used across the site

    const fields = {
      name: { input: form.querySelector("#contact-name"), required: true, label: "your name" },
      phone: { input: form.querySelector("#contact-phone"), required: true, label: "a phone number" },
      email: { input: form.querySelector("#contact-email"), required: false, label: "a valid email address" },
      subject: { input: form.querySelector("#contact-subject"), required: true, label: "a subject" },
      message: { input: form.querySelector("#contact-message"), required: true, label: "a message" },
    };

    function setFieldError(key, message) {
      const fieldEl = form.querySelector(`[data-field="${key}"]`);
      const errorEl = fieldEl?.querySelector("[data-error]");
      if (!fieldEl || !errorEl) return;
      fieldEl.classList.toggle("has-error", Boolean(message));
      errorEl.textContent = message || "";
    }

    function validateField(key) {
      const { input, required, label } = fields[key];
      if (!input) return true;
      const value = input.value.trim();

      if (required && !value) {
        setFieldError(key, `Please enter ${label}.`);
        return false;
      }

      if (key === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        setFieldError(key, "Please enter a valid email address.");
        return false;
      }

      setFieldError(key, "");
      return true;
    }

    // Validate on blur; once a field has shown an error, keep
    // re-checking it live so the message clears as soon as it's fixed.
    Object.keys(fields).forEach((key) => {
      const { input } = fields[key];
      if (!input) return;
      input.addEventListener("blur", () => validateField(key));
      input.addEventListener("input", () => {
        if (form.querySelector(`[data-field="${key}"]`)?.classList.contains("has-error")) {
          validateField(key);
        }
      });
    });

    function buildWhatsAppMessage(values) {
      const lines = [
        "Hello Beauty Pluz,",
        "",
        "I would like to make an enquiry.",
        "",
        "Name:",
        values.name,
        "",
        "Phone:",
        values.phone,
      ];

      if (values.email) {
        lines.push("", "Email:", values.email);
      }

      lines.push("", "Subject:", values.subject, "", "Message:", values.message, "", "Thank you.");
      return lines.join("\n");
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const keys = Object.keys(fields);
      const results = keys.map((key) => validateField(key));
      const firstInvalidIndex = results.indexOf(false);

      if (firstInvalidIndex !== -1) {
        fields[keys[firstInvalidIndex]]?.input?.focus();
        return;
      }

      const values = {
        name: fields.name.input.value.trim(),
        phone: fields.phone.input.value.trim(),
        email: fields.email.input.value.trim(),
        subject: fields.subject.input.value.trim(),
        message: fields.message.input.value.trim(),
      };

      const message = buildWhatsAppMessage(values);
      const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  /* -----------------------------
     Boot
  ------------------------------ */
  document.addEventListener("DOMContentLoaded", () => {
    initAnnouncementBar();
    initHeaderScrollState();
    initScrollReveal();
    initFooterYear();
    initNewsletterForm();
    initContactForm();
    initBackToTop();
  });
})();
