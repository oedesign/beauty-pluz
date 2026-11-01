const productionBackendConfig = {
  supabaseUrl: "https://kdudirbzyiedelpdrgic.supabase.co",
  supabaseAnonKey: "sb_publishable_i7SXukT0COvoQZ5f7a4Sxw_zjTlbAGd",
};

const sumUpPreviewBackendConfig = {
  supabaseUrl: "https://nchoghcxcisxzflyrqcy.supabase.co",
  supabaseAnonKey: "sb_publishable_DTHEyuc2bulp_5I7mBj_-Q_E9NMHOOA",
};

const isSumUpPreview =
  window.location.hostname ===
  "beauty-pluz-git-sumup-payment-oe-designs-projects.vercel.app";
const productionHostnames = new Set([
  "www.beautypluzskincare.co.uk",
  "beauty-pluz.vercel.app",
]);
const isProduction = productionHostnames.has(window.location.hostname);

window.BEAUTY_PLUZ_BACKEND_CONFIG = Object.freeze(
  isSumUpPreview
    ? sumUpPreviewBackendConfig
    : isProduction
    ? productionBackendConfig
    : {},
);
