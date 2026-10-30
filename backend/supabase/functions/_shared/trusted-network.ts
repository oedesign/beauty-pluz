import { callRpc } from "./sumup.ts";

const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function trustedClientNetwork(request: Request): string | null {
  const headerName = Deno.env.get("CHECKOUT_TRUSTED_IP_HEADER");
  if (
    headerName !== "cf-connecting-ip" ||
    Deno.env.get("CHECKOUT_TRUSTED_INGRESS_CONFIRMED") !== "true"
  ) return null;

  const address = request.headers.get(headerName)?.trim();
  if (!address || address.includes(",")) return null;

  const ipv4 = ipv4Pattern.exec(address);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  if (
    !/^[0-9a-f:]+$/i.test(address) || !address.includes(":") ||
    (address.match(/::/g) || []).length > 1
  ) {
    return null;
  }
  const [leftPart, rightPart = ""] = address.toLowerCase().split("::");
  const left = leftPart ? leftPart.split(":") : [];
  const right = rightPart ? rightPart.split(":") : [];
  const missingWords = 8 - left.length - right.length;
  if (
    (address.includes("::") && missingWords < 1) ||
    (!address.includes("::") && missingWords !== 0)
  ) {
    return null;
  }
  const words = [
    ...left,
    ...Array(address.includes("::") ? missingWords : 0).fill("0"),
    ...right,
  ];
  if (
    words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))
  ) return null;
  return `${
    words.slice(0, 4).map((word) => Number.parseInt(word, 16).toString(16))
      .join(":")
  }::/64`;
}

export async function consumeCheckoutRequestLimit(
  network: string,
): Promise<boolean> {
  const keyMaterial = Deno.env.get("CHECKOUT_RATE_LIMIT_HMAC_KEY");
  if (!keyMaterial || new TextEncoder().encode(keyMaterial).byteLength < 32) {
    throw new Error("Checkout rate-limit configuration is unavailable.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(network),
  );
  const identity = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return await callRpc<boolean>("consume_checkout_request_limit", {
    p_identity_hash: `\\x${identity}`,
  });
}
