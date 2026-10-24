const TIMESTAMP_HEADER = "x-beauty-pluz-gateway-timestamp";
const NONCE_HEADER = "x-beauty-pluz-gateway-nonce";
const SIGNATURE_HEADER = "x-beauty-pluz-gateway-signature";
const MAX_CLOCK_SKEW_SECONDS = 60;
// The Edge Runtime strips the public Functions prefix from handler request URLs.
const RUNTIME_TO_CANONICAL_PATH = new Map([
  ["/stripe-checkout", "/functions/v1/stripe-checkout"],
  ["/stripe-guest-handoff", "/functions/v1/stripe-guest-handoff"],
  ["/stripe-guest-status", "/functions/v1/stripe-guest-status"],
  ["/stripe-checkout-recover", "/functions/v1/stripe-checkout-recover"],
  ["/stripe-webhook", "/functions/v1/stripe-webhook"]
]);
const MAX_BODY_BYTES = new Map([
  ["/functions/v1/stripe-checkout", 16 * 1024],
  ["/functions/v1/stripe-guest-handoff", 8 * 1024],
  ["/functions/v1/stripe-guest-status", 8 * 1024],
  ["/functions/v1/stripe-checkout-recover", 8 * 1024]
]);

export function canonicalGatewayPath(runtimePath) {
  return RUNTIME_TO_CANONICAL_PATH.get(runtimePath) ?? null;
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "="
    );
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBody(request, limit) {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)
  ) {
    return null;
  }
  if (!request.body) return null;

  const reader = request.clone().body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > limit) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function consumeNonceThroughSupabase(getEnv, nonceHash, expiresAt) {
  const supabaseUrl = getEnv("SUPABASE_URL")?.trim();
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Gateway assertion store unavailable");

  const endpoint = new URL("/rest/v1/rpc/consume_guest_gateway_assertion_nonce", supabaseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": serviceRoleKey,
      "Authorization": `Bearer ${serviceRoleKey}`
    },
    body: JSON.stringify({
      p_nonce_hash: nonceHash,
      p_expires_at: new Date(expiresAt * 1000).toISOString()
    })
  });
  if (!response.ok) throw new Error("Gateway assertion store unavailable");
  const consumed = await response.json();
  if (typeof consumed !== "boolean") throw new Error("Gateway assertion store unavailable");
  return consumed;
}

export async function verifyGatewayRequest(request, getEnv, options = {}) {
  const publicKeyValue = getEnv("GUEST_GATEWAY_PUBLIC_KEY")?.trim();
  if (!publicKeyValue) return "unavailable";

  const url = new URL(request.url);
  const canonicalPath = canonicalGatewayPath(url.pathname);
  const bodyLimit = canonicalPath ? MAX_BODY_BYTES.get(canonicalPath) : undefined;
  if (request.method !== "POST" || bodyLimit === undefined) return "unauthorized";

  const timestampValue = request.headers.get(TIMESTAMP_HEADER);
  const nonce = request.headers.get(NONCE_HEADER);
  const signatureValue = request.headers.get(SIGNATURE_HEADER);
  if (
    !timestampValue ||
    !/^\d{10}$/.test(timestampValue) ||
    !nonce ||
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    !signatureValue
  ) {
    return "unauthorized";
  }

  const timestamp = Number(timestampValue);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) return "unauthorized";

  const publicKeyBytes = decodeBase64Url(publicKeyValue);
  if (!publicKeyBytes || publicKeyBytes.length !== 32) return "unavailable";
  const signature = decodeBase64Url(signatureValue);
  if (!signature || signature.length !== 64) return "unauthorized";

  let body;
  try {
    body = await readBoundedBody(request, bodyLimit);
  } catch {
    return "unauthorized";
  }
  if (!body) return "unauthorized";

  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch {
    return "unavailable";
  }
  const bodyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const canonical = [
    "beauty-pluz-gateway-v1",
    request.method,
    canonicalPath,
    timestampValue,
    nonce,
    encodeHex(bodyDigest)
  ].join("\n");
  let valid;
  try {
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      new TextEncoder().encode(canonical)
    );
  } catch {
    return "unauthorized";
  }
  if (!valid) return "unauthorized";

  const nonceDigest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(nonce)
  ));
  const consumeNonce = options.consumeNonce ??
    ((hash, expiry) => consumeNonceThroughSupabase(getEnv, hash, expiry));
  try {
    return await consumeNonce(encodeHex(nonceDigest), timestamp + MAX_CLOCK_SKEW_SECONDS)
      ? "authorized"
      : "unauthorized";
  } catch {
    return "unavailable";
  }
}

export function gatewayAuthFailure(status) {
  const responseStatus = status === "unavailable" ? 503 : 401;
  return new Response(JSON.stringify({
    error: responseStatus === 401
      ? "This checkout endpoint is unavailable."
      : "Checkout is temporarily unavailable."
  }), {
    status: responseStatus,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json"
    }
  });
}
