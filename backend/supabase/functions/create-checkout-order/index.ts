import {
  callRpc,
  createHostedCheckout,
  ExpectedCheckout,
  findCheckoutByReference,
  getSumUpConfig,
  hashCheckoutAccessToken,
  isRecord,
  parseVerifiedCheckout,
  persistVerification,
  RpcError,
  SumUpError,
  VerifiedCheckout,
} from "../_shared/sumup.ts";
import { trustedClientNetwork } from "../_shared/trusted-network.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const maxBodyBytes = 16_384;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CheckoutItem = { id: string; quantity: number };
type CheckoutRequest = {
  idempotencyKey: string;
  checkoutAccessToken: string;
  customerName: string;
  customerPhone: string;
  shippingAddress: string;
  countryCode: string;
  postalCode: string;
  items: CheckoutItem[];
};

function jsonResponse(status: number, body: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function validateRequest(value: unknown): CheckoutRequest | null {
  if (
    !isRecord(value) || !Array.isArray(value.items) || value.items.length < 1 ||
    value.items.length > 50
  ) {
    return null;
  }

  const {
    idempotencyKey,
    checkoutAccessToken,
    customerName,
    customerPhone,
    shippingAddress,
    countryCode,
    postalCode,
  } = value;
  if (
    typeof idempotencyKey !== "string" ||
    !uuidPattern.test(idempotencyKey) ||
    typeof checkoutAccessToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(checkoutAccessToken) ||
    typeof customerName !== "string" ||
    typeof customerPhone !== "string" ||
    typeof shippingAddress !== "string" ||
    typeof countryCode !== "string" ||
    typeof postalCode !== "string"
  ) {
    return null;
  }

  const items: CheckoutItem[] = [];
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.length < 1 ||
      item.id.length > 80 ||
      item.id.trim() !== item.id ||
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99
    ) {
      return null;
    }
    items.push({ id: item.id, quantity: item.quantity });
  }

  return {
    idempotencyKey,
    checkoutAccessToken,
    customerName,
    customerPhone,
    shippingAddress,
    countryCode,
    postalCode,
    items,
  };
}

function safeError(status: number, message: string) {
  return jsonResponse(status, { error: message });
}

async function rateLimitIdentity(
  network: string,
  keyMaterial: string,
): Promise<string> {
  const keyBytes = new TextEncoder().encode(keyMaterial);
  if (keyBytes.byteLength < 32) {
    throw new Error("Rate-limit identity key is not configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(network),
  );
  return Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

type CheckoutClaim = {
  checkoutReference: string;
  checkoutId: string | null;
  hostedCheckoutUrl: string | null;
  state: string;
  claimed: boolean;
  amountMinor: number;
  currency: string;
  validUntil: string;
};

async function ensureHostedCheckout(
  orderId: string,
  accessTokenHash: string,
  merchantCode: string,
): Promise<
  { checkoutUrl: string | null; paymentStatus: string; inProgress: boolean }
> {
  const rawClaim = await callRpc<unknown>("claim_sumup_checkout", {
    p_order_id: orderId,
    p_access_token_hash: accessTokenHash,
    p_merchant_code: merchantCode,
  });
  if (!isRecord(rawClaim)) {
    throw new Error("Checkout session could not be confirmed.");
  }
  const claim = rawClaim as unknown as CheckoutClaim;

  if (
    typeof claim.checkoutReference !== "string" ||
    typeof claim.state !== "string" ||
    typeof claim.claimed !== "boolean" ||
    typeof claim.amountMinor !== "number" ||
    !Number.isSafeInteger(claim.amountMinor) ||
    typeof claim.currency !== "string" ||
    typeof claim.validUntil !== "string"
  ) throw new Error("Checkout session could not be confirmed.");

  if (
    claim.state === "pending" && typeof claim.hostedCheckoutUrl === "string"
  ) {
    return {
      checkoutUrl: claim.hostedCheckoutUrl,
      paymentStatus: "pending",
      inProgress: false,
    };
  }
  if (claim.state === "creating" && !claim.claimed) {
    return { checkoutUrl: null, paymentStatus: "pending", inProgress: true };
  }
  if (claim.state !== "creating" || !claim.claimed) {
    throw new RpcError("P0001");
  }

  const sumup = getSumUpConfig();
  if (!sumup || sumup.merchantCode !== merchantCode) {
    throw new Error("Sandbox payment configuration is unavailable.");
  }
  const expected: ExpectedCheckout = {
    checkoutReference: claim.checkoutReference,
    merchantCode,
    amountMinor: claim.amountMinor,
    currency: claim.currency,
  };
  const existing = await findCheckoutByReference(
    claim.checkoutReference,
    sumup,
  );
  if (existing.length > 1) throw new SumUpError();
  const providerCheckout: VerifiedCheckout = existing.length === 1
    ? parseVerifiedCheckout(existing[0], expected)
    : await createHostedCheckout(expected, claim.validUntil, sumup);

  await callRpc<boolean>("save_sumup_checkout", {
    p_order_id: orderId,
    p_checkout_id: providerCheckout.checkoutId,
    p_hosted_checkout_url: providerCheckout.hostedCheckoutUrl,
    p_merchant_code: merchantCode,
  });

  const paymentStatus = providerCheckout.checkoutStatus === "PENDING"
    ? "pending"
    : await persistVerification(orderId, providerCheckout);
  return {
    checkoutUrl: providerCheckout.hostedCheckoutUrl,
    paymentStatus,
    inProgress: false,
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return safeError(405, "Use POST to start checkout.");
  }

  const network = trustedClientNetwork(request);
  const hmacKey = Deno.env.get("CHECKOUT_RATE_LIMIT_HMAC_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sumup = getSumUpConfig();
  if (!network || !hmacKey || !supabaseUrl || !serviceRoleKey || !sumup) {
    return safeError(503, "Checkout is temporarily unavailable.");
  }

  let identityHash: string;
  try {
    identityHash = await rateLimitIdentity(network, hmacKey);
  } catch {
    return safeError(503, "Checkout is temporarily unavailable.");
  }

  let rateLimitResponse: Response;
  try {
    rateLimitResponse = await fetch(
      `${
        supabaseUrl.replace(/\/+$/, "")
      }/rest/v1/rpc/consume_checkout_request_limit`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ p_identity_hash: `\\x${identityHash}` }),
      },
    );
  } catch {
    return safeError(
      503,
      "Checkout is temporarily unavailable. Please try again.",
    );
  }

  if (!rateLimitResponse.ok) {
    return safeError(503, "Checkout is temporarily unavailable.");
  }

  let rateLimitAllowed: unknown;
  try {
    rateLimitAllowed = await rateLimitResponse.json();
  } catch {
    return safeError(503, "Checkout is temporarily unavailable.");
  }
  if (typeof rateLimitAllowed !== "boolean") {
    return safeError(503, "Checkout is temporarily unavailable.");
  }
  if (!rateLimitAllowed) {
    return safeError(
      429,
      "Too many checkout attempts. Please wait and try again.",
    );
  }

  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return safeError(415, "Checkout requests must use JSON.");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return safeError(413, "The checkout request is too large.");
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return safeError(400, "The checkout request could not be read.");
  }
  if (new TextEncoder().encode(rawBody).byteLength > maxBodyBytes) {
    return safeError(413, "The checkout request is too large.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return safeError(400, "The checkout request is not valid JSON.");
  }

  const checkout = validateRequest(payload);
  if (!checkout) {
    return safeError(400, "Enter valid customer, delivery, and cart details.");
  }
  const accessTokenHash = await hashCheckoutAccessToken(
    checkout.checkoutAccessToken,
  );

  let response: Response;
  try {
    response = await fetch(
      `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/create_checkout_order`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_idempotency_key: checkout.idempotencyKey,
          p_customer_name: checkout.customerName,
          p_customer_phone: checkout.customerPhone,
          p_shipping_address: checkout.shippingAddress,
          p_country_code: checkout.countryCode,
          p_postal_code: checkout.postalCode,
          p_checkout_access_token_hash: accessTokenHash,
          p_items: checkout.items,
        }),
      },
    );
  } catch {
    return safeError(
      503,
      "Checkout is temporarily unavailable. Please try again.",
    );
  }

  if (!response.ok) {
    let errorCode = "";
    try {
      const errorBody: unknown = await response.json();
      if (isRecord(errorBody) && typeof errorBody.code === "string") {
        errorCode = errorBody.code;
      }
    } catch {
      return safeError(500, "We could not create the order. Please try again.");
    }

    if (errorCode === "22023") {
      return safeError(
        400,
        "Enter valid customer, delivery, and cart details.",
      );
    }
    if (errorCode === "P0002") {
      return safeError(
        409,
        "One or more items are unavailable or have insufficient stock.",
      );
    }
    if (errorCode === "55000") {
      return safeError(
        503,
        "Checkout is temporarily unavailable while delivery pricing is configured.",
      );
    }
    if (errorCode === "22003") {
      return safeError(400, "The order total is outside the supported range.");
    }
    if (errorCode === "P0001") {
      return safeError(
        409,
        "This checkout request cannot be reused. Please start checkout again.",
      );
    }
    return safeError(500, "We could not create the order. Please try again.");
  }

  let orderId: unknown;
  try {
    orderId = await response.json();
  } catch {
    return safeError(500, "We could not confirm the order. Please try again.");
  }
  if (typeof orderId !== "string" || !uuidPattern.test(orderId)) {
    return safeError(500, "We could not confirm the order. Please try again.");
  }

  try {
    const payment = await ensureHostedCheckout(
      orderId,
      accessTokenHash,
      sumup.merchantCode,
    );
    if (payment.inProgress) {
      return jsonResponse(202, { orderId, paymentStatus: "pending" });
    }
    if (!payment.checkoutUrl) {
      return safeError(
        503,
        "The hosted payment page is not ready. Please retry shortly.",
      );
    }
    return jsonResponse(201, {
      orderId,
      hostedCheckoutUrl: payment.checkoutUrl,
      paymentStatus: payment.paymentStatus,
    });
  } catch (error) {
    if (error instanceof RpcError && error.code === "55000") {
      return safeError(503, "Delivery for this destination is not configured.");
    }
    if (
      error instanceof RpcError &&
      (error.code === "P0001" || error.code === "P0002")
    ) {
      return safeError(
        409,
        "This checkout is no longer available. Please start again.",
      );
    }
    if (error instanceof SumUpError) {
      return safeError(
        503,
        "The sandbox payment service is temporarily unavailable.",
      );
    }
    return safeError(
      503,
      "Checkout is temporarily unavailable. Please try again.",
    );
  }
});
