export type SumUpConfig = {
  apiKey: string;
  merchantCode: string;
};

export type ExpectedCheckout = {
  checkoutId?: string;
  checkoutReference: string;
  merchantCode: string;
  amountMinor: number;
  currency: string;
};

export type VerifiedCheckout = {
  checkoutId: string;
  checkoutReference: string;
  merchantCode: string;
  checkoutStatus: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
  transactionStatus:
    | "SUCCESSFUL"
    | "PENDING"
    | "FAILED"
    | "CANCELLED"
    | "REFUNDED"
    | null;
  amountMinor: number;
  currency: string;
  transactionReference: string | null;
  hostedCheckoutUrl: string;
};

export class SumUpError extends Error {
  constructor(readonly statusCode: number | null = null) {
    super("SumUp request could not be completed.");
  }
}

export class RpcError extends Error {
  constructor(readonly code: string | null = null) {
    super("The checkout service rejected the request.");
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function hashCheckoutAccessToken(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Invalid checkout access token.");
  }
  let tokenBytes: string;
  try {
    tokenBytes = atob(token.replace(/-/g, "+").replace(/_/g, "/") + "=");
  } catch {
    throw new Error("Invalid checkout access token.");
  }
  if (tokenBytes.length !== 32) {
    throw new Error("Invalid checkout access token.");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `\\x${hex}`;
}

export function getSumUpConfig(): SumUpConfig | null {
  if (Deno.env.get("SUMUP_ENVIRONMENT") !== "sandbox") return null;
  const apiKey = Deno.env.get("SUMUP_SANDBOX_API_KEY");
  const merchantCode = Deno.env.get("SUMUP_SANDBOX_MERCHANT_CODE")?.trim();
  if (!apiKey || !merchantCode || merchantCode.length > 40) return null;
  return { apiKey, merchantCode };
}

export function getSupabaseConfig():
  | { url: string; serviceRoleKey: string }
  | null {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ""), serviceRoleKey };
}

export async function callRpc<T>(
  name: string,
  parameters: Record<string, unknown>,
): Promise<T> {
  const config = getSupabaseConfig();
  if (!config) throw new Error("Supabase server configuration is unavailable.");

  let response: Response;
  try {
    response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("The checkout service could not be reached.");
  }
  if (!response.ok) {
    let code: string | null = null;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.code === "string") code = body.code;
    } catch {
      code = null;
    }
    throw new RpcError(code);
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error("The checkout service returned an invalid response.");
  }
}

async function sumUpRequest(
  path: string,
  config: SumUpConfig,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.sumup.com${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SumUpError();
  }
  if (!response.ok) throw new SumUpError(response.status);
  try {
    return await response.json();
  } catch {
    throw new SumUpError(response.status);
  }
}

function amountToMinor(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) && Math.abs(value * 100 - minor) < 0.00001
    ? minor
    : null;
}

function hostedUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "checkout.sumup.com" ||
      !/^\/pay\/[A-Za-z0-9-]+$/.test(url.pathname)
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseVerifiedCheckout(
  value: unknown,
  expected: ExpectedCheckout,
): VerifiedCheckout {
  if (!isRecord(value)) throw new SumUpError();
  const checkoutId = typeof value.id === "string" ? value.id : null;
  const reference = typeof value.checkout_reference === "string"
    ? value.checkout_reference
    : null;
  const merchantCode = typeof value.merchant_code === "string"
    ? value.merchant_code
    : null;
  const status = value.status;
  const amountMinor = amountToMinor(value.amount);
  const currency = typeof value.currency === "string" ? value.currency : null;
  const paymentUrl = hostedUrl(value.hosted_checkout_url);
  if (
    !checkoutId ||
    (expected.checkoutId && checkoutId !== expected.checkoutId) ||
    reference !== expected.checkoutReference ||
    merchantCode !== expected.merchantCode ||
    amountMinor !== expected.amountMinor ||
    currency !== expected.currency ||
    !paymentUrl ||
    !["PENDING", "PAID", "FAILED", "EXPIRED"].includes(String(status))
  ) throw new SumUpError();

  const transactions = Array.isArray(value.transactions)
    ? value.transactions
    : [];
  const sortedTransactions = transactions
    .filter(isRecord)
    .sort((left, right) => {
      const leftTime = typeof left.timestamp === "string"
        ? Date.parse(left.timestamp)
        : 0;
      const rightTime = typeof right.timestamp === "string"
        ? Date.parse(right.timestamp)
        : 0;
      return rightTime - leftTime;
    });
  const successfulTransactions = sortedTransactions.filter((item) =>
    item.status === "SUCCESSFUL"
  );
  if (
    successfulTransactions.some((item) =>
      amountToMinor(item.amount) !== expected.amountMinor ||
      item.currency !== expected.currency
    )
  ) throw new SumUpError();
  const successfulTransaction = successfulTransactions[0];
  const transaction = successfulTransaction ?? sortedTransactions[0];
  const transactionStatus = transaction &&
      ["SUCCESSFUL", "PENDING", "FAILED", "CANCELLED", "REFUNDED"].includes(
        String(transaction.status),
      )
    ? transaction.status as VerifiedCheckout["transactionStatus"]
    : null;
  const transactionReference = transaction && transactionStatus === "SUCCESSFUL"
    ? (typeof transaction.transaction_code === "string" &&
        transaction.transaction_code.length > 0
      ? transaction.transaction_code
      : typeof transaction.id === "string" && transaction.id.length > 0
      ? transaction.id
      : null)
    : null;

  if (
    (status === "PAID" &&
      (!successfulTransaction || transactionStatus !== "SUCCESSFUL")) ||
    (status !== "PAID" && successfulTransaction !== undefined)
  ) {
    throw new SumUpError();
  }

  return {
    checkoutId,
    checkoutReference: reference,
    merchantCode,
    checkoutStatus: status as VerifiedCheckout["checkoutStatus"],
    transactionStatus,
    amountMinor,
    currency,
    transactionReference,
    hostedCheckoutUrl: paymentUrl,
  };
}

export async function findCheckoutByReference(
  reference: string,
  config: SumUpConfig,
): Promise<unknown[]> {
  const result = await sumUpRequest(
    `/v0.1/checkouts?checkout_reference=${encodeURIComponent(reference)}`,
    config,
  );
  if (!Array.isArray(result)) throw new SumUpError();
  return result;
}

export async function createHostedCheckout(
  expected: ExpectedCheckout,
  validUntil: string,
  config: SumUpConfig,
): Promise<VerifiedCheckout> {
  const result = await sumUpRequest("/v0.1/checkouts", config, {
    method: "POST",
    body: JSON.stringify({
      amount: expected.amountMinor / 100,
      checkout_reference: expected.checkoutReference,
      currency: expected.currency,
      description: "Beauty Pluz order",
      hosted_checkout: { enabled: true },
      merchant_code: expected.merchantCode,
      valid_until: validUntil,
    }),
  });
  return parseVerifiedCheckout(result, expected);
}

export async function retrieveCheckout(
  checkoutId: string,
  expected: ExpectedCheckout,
  config: SumUpConfig,
): Promise<VerifiedCheckout> {
  const result = await sumUpRequest(
    `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
    config,
  );
  return parseVerifiedCheckout(result, { ...expected, checkoutId });
}

export async function verifyViaCheckoutReference(
  expected: ExpectedCheckout,
  config: SumUpConfig,
): Promise<VerifiedCheckout | null> {
  const results = await findCheckoutByReference(
    expected.checkoutReference,
    config,
  );
  if (results.length === 0) return null;
  if (results.length !== 1) throw new SumUpError();
  return parseVerifiedCheckout(results[0], expected);
}

export async function persistVerification(
  orderId: string,
  checkout: VerifiedCheckout,
): Promise<string> {
  return await callRpc<string>("record_sumup_checkout_verification", {
    p_order_id: orderId,
    p_checkout_id: checkout.checkoutId,
    p_checkout_reference: checkout.checkoutReference,
    p_merchant_code: checkout.merchantCode,
    p_checkout_status: checkout.checkoutStatus,
    p_transaction_status: checkout.transactionStatus,
    p_amount_minor: checkout.amountMinor,
    p_currency: checkout.currency,
    p_transaction_reference: checkout.transactionReference,
  });
}
