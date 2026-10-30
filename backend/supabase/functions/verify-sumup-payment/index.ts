import {
  callRpc,
  ExpectedCheckout,
  findCheckoutByReference,
  getSumUpConfig,
  hashCheckoutAccessToken,
  isRecord,
  parseVerifiedCheckout,
  persistVerification,
  retrieveCheckout,
  RpcError,
  SumUpError,
  VerifiedCheckout,
} from "../_shared/sumup.ts";
import {
  consumeCheckoutRequestLimit,
  trustedClientNetwork,
} from "../_shared/trusted-network.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type VerificationSession = {
  orderId: string;
  checkoutReference: string;
  checkoutId: string | null;
  hostedCheckoutUrl: string | null;
  state: string;
  merchantCode: string;
  amountMinor: number;
  currency: string;
};

function response(status: number, body: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return response(405, { error: "Use POST to check payment status." });
  }

  const network = trustedClientNetwork(request);
  if (!network) {
    return response(503, {
      error: "Payment status is temporarily unavailable.",
    });
  }
  try {
    if (!await consumeCheckoutRequestLimit(network)) {
      return response(429, {
        error: "Too many payment status checks. Please wait and try again.",
      });
    }
  } catch {
    return response(503, {
      error: "Payment status is temporarily unavailable.",
    });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return response(415, { error: "Payment status requests must use JSON." });
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 2048) {
    return response(413, { error: "The payment status request is too large." });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return response(400, { error: "The payment status request is invalid." });
  }
  if (
    !isRecord(payload) ||
    typeof payload.orderId !== "string" ||
    !uuidPattern.test(payload.orderId) ||
    typeof payload.checkoutAccessToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.checkoutAccessToken)
  ) return response(400, { error: "The payment status request is invalid." });

  let tokenHash: string;
  try {
    tokenHash = await hashCheckoutAccessToken(payload.checkoutAccessToken);
  } catch {
    return response(400, { error: "The payment status request is invalid." });
  }

  try {
    const rawSession = await callRpc<unknown>(
      "get_sumup_checkout_for_verification",
      {
        p_order_id: payload.orderId,
        p_access_token_hash: tokenHash,
      },
    );
    if (!isRecord(rawSession)) {
      return response(503, {
        error: "Payment status is temporarily unavailable.",
      });
    }
    const session = rawSession as unknown as VerificationSession;
    if (
      typeof session.orderId !== "string" ||
      typeof session.checkoutReference !== "string" ||
      typeof session.state !== "string" ||
      typeof session.merchantCode !== "string" ||
      typeof session.amountMinor !== "number" ||
      !Number.isSafeInteger(session.amountMinor) ||
      typeof session.currency !== "string"
    ) {
      return response(503, {
        error: "Payment status is temporarily unavailable.",
      });
    }

    if (["paid", "failed", "cancelled", "expired"].includes(session.state)) {
      return response(200, { paymentStatus: session.state });
    }

    const sumup = getSumUpConfig();
    if (!sumup || sumup.merchantCode !== session.merchantCode) {
      return response(503, {
        error: "Payment status is temporarily unavailable.",
      });
    }
    const expected: ExpectedCheckout = {
      checkoutId: session.checkoutId ?? undefined,
      checkoutReference: session.checkoutReference,
      merchantCode: session.merchantCode,
      amountMinor: session.amountMinor,
      currency: session.currency,
    };

    let checkout: VerifiedCheckout | null = null;
    if (session.checkoutId) {
      checkout = await retrieveCheckout(session.checkoutId, expected, sumup);
    } else if (session.state === "creating") {
      const matches = await findCheckoutByReference(
        session.checkoutReference,
        sumup,
      );
      if (matches.length > 1) throw new SumUpError();
      if (matches.length === 1) {
        checkout = parseVerifiedCheckout(matches[0], expected);
        await callRpc<boolean>("save_sumup_checkout", {
          p_order_id: session.orderId,
          p_checkout_id: checkout.checkoutId,
          p_hosted_checkout_url: checkout.hostedCheckoutUrl,
          p_merchant_code: session.merchantCode,
        });
        checkout = await retrieveCheckout(checkout.checkoutId, expected, sumup);
      }
    }

    if (!checkout) return response(200, { paymentStatus: "pending" });
    const paymentStatus = await persistVerification(session.orderId, checkout);
    return response(200, { paymentStatus });
  } catch (error) {
    if (error instanceof RpcError && error.code === "P0002") {
      return response(404, { error: "Payment status is unavailable." });
    }
    if (error instanceof SumUpError) {
      return response(503, {
        error: "Payment status is temporarily unavailable.",
      });
    }
    return response(503, {
      error: "Payment status is temporarily unavailable.",
    });
  }
});
