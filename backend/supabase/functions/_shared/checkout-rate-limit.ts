import { callRpc } from "./sumup.ts";

type RateLimitPurpose = "checkout-phone" | "payment-token";

export function normalizeCheckoutPhone(
  phone: string,
  countryCode: string,
): string | null {
  const country = countryCode.trim().toUpperCase();
  const value = phone.trim();
  if (
    !/^[A-Z]{2}$/.test(country) ||
    value.length < 5 ||
    value.length > 40 ||
    !/^[+0-9() .-]+$/.test(value)
  ) return null;

  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 5 || digits.length > 15) return null;

  return `${country}:${digits}`;
}

export async function createCheckoutRateLimitIdentity(
  purpose: RateLimitPurpose,
  value: string,
  keyMaterial: string,
): Promise<string> {
  const keyBytes = new TextEncoder().encode(keyMaterial);
  if (keyBytes.byteLength < 32 || !value) {
    throw new Error("Checkout rate-limit configuration is unavailable.");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`beauty-pluz:${purpose}:v1:${value}`),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function consumeCheckoutRequestLimit(
  identityHash: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(identityHash)) {
    throw new Error("Checkout rate-limit identity is invalid.");
  }

  const allowed: unknown = await callRpc<unknown>(
    "consume_checkout_request_limit",
    { p_identity_hash: `\\x${identityHash}` },
  );
  if (typeof allowed !== "boolean") {
    throw new Error("Checkout rate-limit response is invalid.");
  }
  return allowed;
}
