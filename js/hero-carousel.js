/* =========================================================
   BEAUTY PLUZ — HERO-CAROUSEL.JS
   Data-driven, auto-rotating hero carousel for the homepage.
   Slides are defined once in the SLIDES array below (add/edit/
   remove a slide by editing this array — no other code needs to
   change) and rendered into the DOM by renderSlide()/renderDot().

   Images are real, licensed Unsplash photography (free tier —
   see the note above SLIDES for licensing details), requested at
   a size appropriate to the viewport via buildImageUrl().

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
   * Slide shape:
   * {
   *   id: string,
   *   imageId: string       — Unsplash photo ID (see note below)
   *   theme: string          — ink-tinted gradient painted underneath
   *                            the photo; shows instantly before the
   *                            photo loads, and stays as a fallback if
   *                            it ever fails to load
   *   credit: { name, profileUrl } — photographer, for the credits
   *                            comment below (Unsplash's License does
   *                            not require on-page attribution, but
   *                            it's good practice to keep it on record)
   *   eyebrow: string,
   *   heading: string,
   *   description: string,
   *   primaryCta: { label, href },
   *   secondaryCta: { label, href } | null,
   *   align: "left" | "right"  — which side the text panel sits on
   * }
   *
   * Photography: real, licensed photos from Unsplash (free tier —
   * Unsplash License: free for commercial use, no attribution
   * required: https://unsplash.com/license). buildImageUrl() below
   * requests each photo through Unsplash's own imgix-based resizing
   * endpoint (the same one unsplash.com itself uses) at a size
   * appropriate to the viewport, cropped to a wide hero aspect ratio,
   * and with auto=format so supporting browsers get WebP/AVIF instead
   * of a full JPEG — this is the "optimize for performance" piece.
   */
  const SLIDES = [
    {
      id: "slow-mornings",
      imageId: "1643379850623-7eb6442cd262",
      theme: "sage",
      credit: { name: "Cherrydeck", profileUrl: "https://unsplash.com/@cherrydeck" },
      eyebrow: "Clean · Clinical · Considered",
      heading: "Skincare made for slow mornings",
      description:
        "Small-batch, botanical formulas made to slow you down — five considered minutes with ingredients your skin will thank you for.",
      primaryCta: { label: "Shop Now", href: "shop.html" },
      secondaryCta: { label: "Explore Collection", href: "shop.html" },
      align: "left",
    },
    {
      id: "your-ritual",
      imageId: "1741896135490-4062a3b21abf",
      theme: "rose",
      credit: { name: "Maria Lupan", profileUrl: "https://unsplash.com/@luandmario" },
      eyebrow: "Your Skin, Your Ritual",
      heading: "Discover your perfect skincare routine",
      description:
        "Thoughtfully selected products for healthy, glowing skin — build a routine that actually fits your mornings.",
      primaryCta: { label: "Shop Skincare", href: "shop.html" },
      secondaryCta: null,
      align: "left",
    },
    {
      id: "new-arrivals",
      imageId: "1620916297397-a4a5402a3c6c",
      theme: "blush",
      credit: { name: "Mathilde Langevin", profileUrl: "https://unsplash.com/@mathildelangevin" },
      eyebrow: "New Arrivals",
      heading: "Meet your new skincare essentials",
      description:
        "Explore our latest products and build your daily ritual with our newest botanical formulas.",
      primaryCta: { label: "Shop New Arrivals", href: "shop.html" },
      secondaryCta: null,
      align: "right",
    },
  ];

  // Photo credits (Unsplash License — no attribution legally required,
  // kept here for provenance): Cherrydeck, Maria Lupan, Mathilde
  // Langevin. See each slide's `credit` field above for profile links.

  /** Builds a sized, cropped, format-optimized Unsplash image URL.
      Requests a smaller image for phones than for desktop, so mobile
      visitors aren't downloading a full desktop-width hero photo. */
  function buildImageUrl(imageId) {
    const width = window.innerWidth < 768 ? 900 : window.innerWidth < 1280 ? 1600 : 1920;
    const height = Math.round(width * (9 / 16));
    return (
      `https://images.unsplash.com/photo-${imageId}` +
      `?w=${width}&h=${height}&fit=crop&crop=entropy&auto=format&q=75`
    );
  }

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
        <div class="hero-carousel__media" data-theme="${slide.theme}" style="background-image: url('${buildImageUrl(slide.imageId)}');" aria-hidden="true"></div>
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
