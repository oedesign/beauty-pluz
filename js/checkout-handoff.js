(function () {
  var handoff = new URLSearchParams(window.location.hash.slice(1)).get("handoff");
  window.BEAUTY_PLUZ_CHECKOUT_HANDOFF = handoff;
  if (handoff && /^[A-Za-z0-9_-]{43}$/.test(handoff)) {
    try {
      window.sessionStorage.setItem(
        "beautyPluzCheckoutReturn:v1",
        JSON.stringify({ handoffToken: handoff })
      );
    } catch {
      // Continue with the in-memory handoff when tab storage is unavailable.
    }
  }
  if (window.location.hash || new URLSearchParams(window.location.search).has("session_id")) {
    var search = new URLSearchParams(window.location.search);
    search.delete("session_id");
    var query = search.toString();
    window.history.replaceState(
      null,
      document.title,
      window.location.pathname + (query ? "?" + query : "")
    );
  }
})();
