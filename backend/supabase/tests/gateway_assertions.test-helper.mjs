import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const gatewayTestKeys = Object.freeze({
  privateKey: encodeBase64Url(privateKeyBytes),
  publicKey: encodeBase64Url(publicKeyBytes)
});

export async function gatewayAssertionHeaders(
  urlValue,
  method,
  body,
  options = {}
) {
  const url = new URL(urlValue);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const bodyDigest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  ));
  const canonical = [
    "beauty-pluz-gateway-v1",
    method,
    url.pathname,
    timestamp,
    nonce,
    encodeHex(bodyDigest)
  ].join("\n");
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    keyPair.privateKey,
    new TextEncoder().encode(canonical)
  );
  return {
    "x-beauty-pluz-gateway-timestamp": timestamp,
    "x-beauty-pluz-gateway-nonce": nonce,
    "x-beauty-pluz-gateway-signature": encodeBase64Url(new Uint8Array(signature))
  };
}
