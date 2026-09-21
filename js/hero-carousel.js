/* =========================================================
   BEAUTY PLUZ — HERO-CAROUSEL.JS
   Data-driven, auto-rotating hero carousel for the homepage.
   Slides are defined once in the SLIDES array below (add/edit/
   remove a slide by editing this array — no other code needs to
   change) and rendered into the DOM by renderSlide()/renderDot().

   Every slide points to a local image file in images/hero/, so the
   carousel works without a remote image service.

   Behaviour:
   - Advances automatically every 5.5s.
   - Pauses on hover and on keyboard focus within the carousel.
   - Manual navigation (arrows/dots/keyboard) resets the autoplay
     timer so it doesn't fight the person's own navigation.
   - Loops from the last slide back to the first.
   - Horizontal-slide transition via a translateX transform on the
     track; respects prefers-reduced-motion (see the matching CSS
     rule in style.css, which removes the transition — this file
     additionally skips starting autoplay in that case).
   ========================================================= */

(function () {
  "use strict";

  /**
   * Slide shape: { id, image, theme, eyebrow, heading, description,
   * primaryCta, secondaryCta, align }. Add, remove, or reorder objects in
   * this list and place the corresponding local file in images/hero/.
   */
  const SLIDES = [
    {
      id: "",
      image: "images/hero/skincare-product-hero-image1.jpeg",
      theme: "",
      eyebrow: "",
      heading: "",
      description:
        "",
      primaryCta: { label: "Shop Now", href: "shop.html" },
      secondaryCta: { label: "Explore Collection", href: "shop.html" },
      align: "left",
    },
    {
      id: "",
      image: "images/hero/skincare-product-hero-image2.jpeg",
      theme: "",
      eyebrow: "",
      heading: "",
      description:
        "",
      primaryCta: { label: "Shop Skincare", href: "shop.html" },
      secondaryCta: null,
      align: "left",
    },
    {
      id: "",
      image: "images/hero/skincare-product-hero-image3.jpeg",
      theme: "",
      eyebrow: "",
      heading: "",
      description:
        "",
      primaryCta: { label: "Shop New Arrivals", href: "shop.html" },
      secondaryCta: null,
      align: "right",
    },
    {
      id: "",
      image: "images/hero/skincare-product-hero-image4.jpeg",
      theme: "",
      eyebrow: "",
      heading: "",
      description:
        "",
      primaryCta: { label: "Shop New Arrivals", href: "shop.html" },
      secondaryCta: null,
      align: "right",
    },
    {
      id: "",
      image: "images/hero/skincare-product-hero-image5.jpeg",
      theme: "",
      eyebrow: "",
      heading: "",
      description:
        "",
      primaryCta: { label: "Shop New Arrivals", href: "shop.html" },
      secondaryCta: null,
      align: "right",
    },
  ];

  // Images are deliberately local. Add, remove, or reorder entries in
  // SLIDES and place the corresponding file in images/hero/.

  const AUTOPLAY_INTERVAL_MS = 5500;

  function renderCta(cta, variant) {
    if (!cta) return "";
    return `<a href="${cta.href}" class="btn ${variant}">${cta.label}</a>`;
  }

  function renderSlide(slide, index, total) {
    const alignClass =
      slide.align === "right" ? " hero-carousel__slide--align-right" : "";

    return `
      <div
        class="hero-carousel__slide${alignClass}"
        data-slide-index="${index}"
        role="group"
        aria-roledescription="slide"
        aria-label="Slide ${index + 1} of ${total}"
        aria-hidden="${index === 0 ? "false" : "true"}"
      >
        <div class="hero-carousel__media" data-theme="${slide.theme}" style="background-image: url('${slide.image}');" aria-hidden="true"></div>
        <div class="hero-carousel__scrim" aria-hidden="true"></div>
        <div class="hero-carousel__content">
          <div class="hero-carousel__inner">
            <span class="eyebrow eyebrow--on-dark">${slide.eyebrow}</span>
            <h1 class="hero-carousel__heading">${slide.heading}</h1>
            <p class="hero-carousel__text">${slide.description}</p>
            <div class="hero-carousel__actions">
              ${renderCta(slide.primaryCta, "btn--rose")}
              ${renderCta(slide.secondaryCta, "btn--light")}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderDot(index, isActive) {
    return `
      <button
        type="button"
        class="hero-carousel__dot"
        data-dot-index="${index}"
        aria-label="Go to slide ${index + 1}"
        aria-current="${isActive ? "true" : "false"}"
      ></button>
    `;
  }

  /** On-brand gradient painted underneath each slide's real photo.
      It's visible for an instant before the photo finishes loading,
      and stays as the fallback if the photo ever fails to load (link
      rot, offline, etc.) — so a slide never shows a blank or broken
      background. */
  const THEME_GRADIENTS = {
    sage: "linear-gradient(135deg, #4f5f49 0%, #262420 100%)",
    rose: "linear-gradient(135deg, #96525d 0%, #262420 100%)",
    blush: "linear-gradient(135deg, #c98f7d 0%, #262420 100%)",
  };

  function applyThemeFallback(root) {
    root.querySelectorAll("[data-theme]").forEach((el) => {
      const theme = el.getAttribute("data-theme");
      const gradient = THEME_GRADIENTS[theme];
      if (!gradient) return;
      // Layer the gradient underneath the photo url() already set
      // inline, so it's the first thing visible on paint and the
      // fallback if the photo request ever fails.
      const existing = el.style.backgroundImage;
      el.style.backgroundImage = `${existing}, ${gradient}`;
    });
  }

  function initHeroCarousel() {
    const root = document.querySelector("[data-hero-carousel]");
    if (!root) return;

    const track = root.querySelector("[data-carousel-track]");
    const dotsContainer = root.querySelector("[data-carousel-dots]");
    const prevBtn = root.querySelector("[data-carousel-prev]");
    const nextBtn = root.querySelector("[data-carousel-next]");
    if (!track) return;

    const total = SLIDES.length;
    let currentIndex = 0;
    let autoplayId = null;

    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // --- Initial render ---
    track.innerHTML = SLIDES.map((slide, i) => renderSlide(slide, i, total)).join("");
    applyThemeFallback(track);

    if (dotsContainer) {
      dotsContainer.innerHTML = SLIDES.map((_, i) => renderDot(i, i === 0)).join("");
    }

    const slideEls = Array.from(track.querySelectorAll("[data-slide-index]"));
    const dotEls = dotsContainer
      ? Array.from(dotsContainer.querySelectorAll("[data-dot-index]"))
      : [];

    function goToSlide(index) {
      currentIndex = ((index % total) + total) % total; // wrap both directions
      track.style.transform = `translateX(-${currentIndex * 100}%)`;

      slideEls.forEach((el, i) => {
        el.setAttribute("aria-hidden", i === currentIndex ? "false" : "true");
      });

      dotEls.forEach((dot, i) => {
        dot.setAttribute("aria-current", i === currentIndex ? "true" : "false");
      });
    }

    function nextSlide() {
      goToSlide(currentIndex + 1);
    }

    function prevSlide() {
      goToSlide(currentIndex - 1);
    }

    function startAutoplay() {
      if (prefersReducedMotion || autoplayId !== null) return;
      autoplayId = window.setInterval(nextSlide, AUTOPLAY_INTERVAL_MS);
    }

    function stopAutoplay() {
      if (autoplayId === null) return;
      window.clearInterval(autoplayId);
      autoplayId = null;
    }

    /** Called after any manual navigation so the autoplay clock
        restarts from a fresh interval rather than firing again
        moments after the person just navigated themselves. */
    function resetAutoplay() {
      stopAutoplay();
      startAutoplay();
    }

    // --- Arrow controls ---
    prevBtn?.addEventListener("click", () => {
      prevSlide();
      resetAutoplay();
    });

    nextBtn?.addEventListener("click", () => {
      nextSlide();
      resetAutoplay();
    });

    // --- Dot controls ---
    dotsContainer?.addEventListener("click", (event) => {
      const dot = event.target.closest("[data-dot-index]");
      if (!dot) return;
      goToSlide(parseInt(dot.getAttribute("data-dot-index"), 10));
      resetAutoplay();
    });

    // --- Keyboard navigation (left/right arrows while focus is
    //     anywhere inside the carousel) ---
    root.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        prevSlide();
        resetAutoplay();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        nextSlide();
        resetAutoplay();
      }
    });

    // --- Pause on hover (desktop) ---
    root.addEventListener("mouseenter", stopAutoplay);
    root.addEventListener("mouseleave", startAutoplay);

    // --- Pause while a keyboard user is focused inside the
    //     carousel, so controls don't shift under them mid-interaction ---
    root.addEventListener("focusin", stopAutoplay);
    root.addEventListener("focusout", (event) => {
      // Only resume if focus has left the carousel entirely, not
      // just moved from one control inside it to another.
      if (!root.contains(event.relatedTarget)) {
        startAutoplay();
      }
    });

    goToSlide(0);
    startAutoplay();
  }

  document.addEventListener("DOMContentLoaded", initHeroCarousel);
})();
