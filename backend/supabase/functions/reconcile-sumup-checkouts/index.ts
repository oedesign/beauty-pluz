import {
  callRpc,
  findCheckoutByReference,
  getSumUpConfig,
  isRecord,
  parseVerifiedCheckout,
  persistVerification,
  retrieveCheckout,
  SumUpError,
} from "../_shared/sumup.ts";
import {
  hasServiceRoleClaim,
  reconcileDueCheckouts,
} from "../_shared/reconciliation.mjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type DueCheckout = {
  orderId: string;
  checkoutReference: string;
  checkoutId: string | null;
  state: string;
  merchantCode: string;
  amountMinor: number;
  currency: string;
};

function response(status: number, body: Record<string, number | string>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function parseDueCheckout(value: unknown): DueCheckout | null {
  if (
    !isRecord(value) ||
    typeof value.orderId !== "string" ||
    typeof value.checkoutReference !== "string" ||
    typeof value.state !== "string" ||
    typeof value.merchantCode !== "string" ||
    typeof value.amountMinor !== "number" ||
    !Number.isSafeInteger(value.amountMinor) ||
    typeof value.currency !== "string" ||
    (value.checkoutId !== null && typeof value.checkoutId !== "string")
  ) return null;
  return value as unknown as DueCheckout;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return response(405, { error: "Use POST for scheduled reconciliation." });
  }
  // Supabase's gateway verifies the JWT signature because verify_jwt is enabled.
  if (!hasServiceRoleClaim(request.headers.get("authorization"))) {
    return response(401, { error: "Unauthorized." });
  }

  try {
    let releasedReservations = await callRpc<number>(
      "release_expired_checkout_reservations",
      {
        p_batch_size: 100,
      },
    );
    const rawDue = await callRpc<unknown>("get_due_sumup_checkouts", {
      p_batch_size: 2,
    });
    if (!Array.isArray(rawDue)) {
      return response(503, {
        error: "Reconciliation is temporarily unavailable.",
      });
    }

    if (rawDue.length === 0) {
      return response(200, {
        examined: 0,
        paid: 0,
        pending: 0,
        failed: 0,
        cancelled: 0,
        expired: 0,
        errors: 0,
        providerErrors: 0,
        releasedReservations,
      });
    }

    const sumup = getSumUpConfig();
    if (!sumup) {
      return response(503, {
        error: "Sandbox payment configuration is unavailable.",
      });
    }

    const counts = await reconcileDueCheckouts(rawDue, {
      merchantCode: sumup.merchantCode,
      sumup,
      SumUpError,
      parseDueCheckout,
      findCheckoutByReference,
      parseVerifiedCheckout,
      retrieveCheckout,
      persistVerification,
      callRpc,
    });
    releasedReservations += await callRpc<number>(
      "release_expired_checkout_reservations",
      {
        p_batch_size: 100,
      },
    );

    if (counts.errors > 0) {
      console.warn("SumUp reconciliation completed with item errors.", {
        examined: counts.examined,
        errors: counts.errors,
        providerErrors: counts.providerErrors,
      });
    }
    return response(200, { ...counts, releasedReservations });
  } catch (error) {
    if (error instanceof SumUpError) {
      console.error("SumUp reconciliation run failed.");
      return response(503, {
        error: "SumUp reconciliation is temporarily unavailable.",
      });
    }
    console.error("SumUp reconciliation run failed.");
    return response(503, {
      error: "Reconciliation is temporarily unavailable.",
    });
  }
});
