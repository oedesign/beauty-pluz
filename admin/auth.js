import { supabase, verifyAdminSession } from "./client.js";

(() => {
  "use strict";

  const loginPath = "/admin/login.html";
  const dashboardPath = "/admin/index.html";
  const status = document.querySelector("[data-admin-status]");

  function setStatus(message, isError = false) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("is-error", isError);
    status.hidden = !message;
  }

  function redirectToLogin(reason) {
    const query = reason ? `?reason=${encodeURIComponent(reason)}` : "";
    window.location.replace(`${loginPath}${query}`);
  }

  if (!supabase) {
    setStatus(
      "Admin sign-in is not configured. Add the public Supabase project URL and anon key in js/backend-config.js.",
      true
    );
    document.querySelectorAll("[data-admin-submit]").forEach((button) => {
      button.disabled = true;
    });
    return;
  }

  async function clearAdminSession() {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) throw error;
  }

  async function checkExistingLogin() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data.session) return false;

    if (await verifyAdminSession()) {
      window.location.replace(dashboardPath);
      return true;
    }

    await clearAdminSession();
    setStatus("This account is not authorized to access the admin dashboard.", true);
    return true;
  }

  function initLoginPage() {
    const form = document.querySelector("[data-admin-login]");
    if (!form) return false;

    const emailInput = form.querySelector('input[name="email"]');
    const passwordInput = form.querySelector('input[name="password"]');
    const submitButton = form.querySelector("[data-admin-submit]");
    const params = new URLSearchParams(window.location.search);

    if (params.get("reason") === "unauthorized") {
      setStatus("Administrator access is required to open that page.", true);
    }

    checkExistingLogin().catch((error) => {
      console.error("Beauty Pluz admin: could not verify the current session.", error);
      setStatus("We could not verify your session. Please try again.", true);
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setStatus("");
      if (submitButton) submitButton.disabled = true;

      let data;
      let error;
      try {
        ({ data, error } = await supabase.auth.signInWithPassword({
          email: emailInput.value.trim(),
          password: passwordInput.value,
        }));
      } catch (signInError) {
        console.error("Beauty Pluz admin: sign-in request failed.", signInError);
        setStatus("We could not reach the sign-in service. Check your connection and try again.", true);
        if (submitButton) submitButton.disabled = false;
        return;
      }

      if (error) {
        console.error("Beauty Pluz admin: sign-in failed.", error);
        setStatus("Sign-in failed. Check your email and password, then try again.", true);
        if (submitButton) submitButton.disabled = false;
        return;
      }

      if (!data.session) {
        setStatus("Sign-in did not create a session. Please try again.", true);
        if (submitButton) submitButton.disabled = false;
        return;
      }

      try {
        if (!(await verifyAdminSession())) {
          await clearAdminSession();
          setStatus("This account is not authorized to access the admin dashboard.", true);
          if (submitButton) submitButton.disabled = false;
          return;
        }
        window.location.replace(dashboardPath);
      } catch (verificationError) {
        console.error("Beauty Pluz admin: authorization verification failed.", verificationError);
        try {
          await clearAdminSession();
          setStatus("We could not verify administrator access. Please try again.", true);
        } catch (signOutError) {
          console.error("Beauty Pluz admin: could not clear the unverified session.", signOutError);
          setStatus("Administrator access could not be verified. Sign out and try again.", true);
        }
        if (submitButton) submitButton.disabled = false;
      }
    });

    return true;
  }

  async function initDashboard() {
    const app = document.querySelector("[data-admin-app]");
    if (!app) return false;

    const session = await verifyAdminSession();
    if (!session) {
      redirectToLogin();
      return true;
    }

    const email = app.querySelector("[data-admin-email]");
    if (email) email.textContent = session.user.email || "Administrator";
    initializeAdminNavigation();
    app.hidden = false;
    setStatus("");

    const logoutButton = app.querySelector("[data-admin-logout]");
    logoutButton?.addEventListener("click", async () => {
      logoutButton.disabled = true;
      setStatus("");
      try {
        await clearAdminSession();
      } catch (signOutError) {
        console.error("Beauty Pluz admin: sign-out failed.", signOutError);
        logoutButton.disabled = false;
        setStatus("Sign-out failed. Please try again.", true);
        return;
      }
      window.location.replace(loginPath);
    });

    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") redirectToLogin();
    });

    return true;
  }

  function initializeAdminNavigation() {
    const sidebar = document.querySelector(".admin-sidebar");
    const navigation = sidebar?.querySelector(".admin-nav");
    if (!sidebar || !navigation || sidebar.querySelector("[data-admin-menu-toggle]")) return;

    const brand = sidebar.querySelector(".admin-brand--sidebar");
    const toggle = document.createElement("button");
    const navigationId = "admin-primary-navigation";
    const header = document.createElement("div");
    header.className = "admin-sidebar__header";
    sidebar.insertBefore(header, sidebar.firstChild);
    if (brand) header.append(brand);
    navigation.id = navigationId;
    toggle.className = "admin-button admin-button--quiet admin-menu-toggle";
    toggle.type = "button";
    toggle.dataset.adminMenuToggle = "";
    toggle.setAttribute("aria-controls", navigationId);
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "Menu";
    header.append(toggle);

    function setOpen(open) {
      sidebar.classList.toggle("is-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Close menu" : "Menu";
    }

    toggle.addEventListener("click", () => {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    navigation.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
    window.matchMedia("(min-width: 721px)").addEventListener("change", (event) => {
      if (event.matches) setOpen(false);
    });
  }

  if (!initLoginPage()) {
    initDashboard().catch((error) => {
      console.error("Beauty Pluz admin: dashboard authorization failed.", error);
      redirectToLogin("unauthorized");
    });
  }
})();
