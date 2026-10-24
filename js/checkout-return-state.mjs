const STORAGE_KEY = "beautyPluzCheckoutReturn:v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function getStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.handoffToken === "string" && TOKEN_PATTERN.test(value.handoffToken)) {
    return { handoffToken: value.handoffToken };
  }
  if (typeof value.statusToken !== "string" || !TOKEN_PATTERN.test(value.statusToken)) {
    return null;
  }
  return { statusToken: value.statusToken };
}

export function readCheckoutReturnState(storage) {
  const target = getStorage(storage);
  if (!target) return null;
  try {
    return normalizeState(JSON.parse(target.getItem(STORAGE_KEY)));
  } catch {
    return null;
  }
}

export function writeCheckoutReturnState(value, storage) {
  const target = getStorage(storage);
  const state = normalizeState(value);
  if (!target || !state) return false;
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearCheckoutReturnState(storage) {
  const target = getStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
