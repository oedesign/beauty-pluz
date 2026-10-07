import { supabase, verifyAdminSession } from "./client.js";

(() => {
  "use strict";

  const status = document.querySelector("[data-dashboard-status]");
  const metrics = document.querySelector("[data-dashboard-metrics]");

  function showError(message) {
    status.textContent = message;
    status.classList.add("is-error");
    status.hidden = false;
  }

  async function initialize() {
    if (!metrics) return;
    try {
      const session = await verifyAdminSession();
      if (!session) return;

      const [productResult, homepageResult, orderResult] = await Promise.all([
        supabase.from("products").select("stock_quantity"),
        supabase.rpc("get_admin_homepage_content"),
        supabase.rpc("get_admin_orders", {
          search_term: null,
          status_filter: null,
          result_limit: 1,
          result_offset: 0,
        }),
      ]);
      const failures = [];

      if (productResult.error) {
        failures.push("Catalogue metrics are unavailable.");
      } else {
        const products = productResult.data || [];
        document.querySelector("[data-metric-products]").textContent = String(products.length);
        document.querySelector("[data-metric-low-stock]").textContent = String(
          products.filter((product) => product.stock_quantity !== null
            && product.stock_quantity > 0
            && product.stock_quantity <= 5).length
        );
      }

      if (homepageResult.error) {
        failures.push("Homepage metrics are unavailable.");
      } else {
        const publishedFeatured = homepageResult.data?.published?.featuredProductIds;
        document.querySelector("[data-metric-featured]").textContent = String(
          Array.isArray(publishedFeatured) ? publishedFeatured.length : 0
        );
      }

      if (orderResult.error) {
        failures.push("Order count is unavailable.");
      } else {
        document.querySelector("[data-metric-orders]").textContent = String(
          Number(orderResult.data?.total) || 0
        );
      }

      if (failures.length) {
        showError(failures.join(" "));
      } else {
        status.textContent = "Store metrics updated.";
        status.hidden = true;
      }
    } catch (error) {
      console.error("Beauty Pluz admin: dashboard metrics could not be loaded.", error);
      showError("Store metrics could not be loaded. Refresh the page or check your administrator access.");
    } finally {
      metrics.setAttribute("aria-busy", "false");
    }
  }

  initialize();
})();
