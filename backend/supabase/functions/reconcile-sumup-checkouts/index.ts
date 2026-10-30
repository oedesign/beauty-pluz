import {
  callRpc,
  ExpectedCheckout,
  findCheckoutByReference,
  getSumUpConfig,
  isRecord,
  parseVerifiedCheckout,
  persistVerification,
  retrieveCheckout,
  SumUpError,
  VerifiedCheckout,
} from "../_shared/sumup.ts";

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

function isTrustedSchedulerRequest(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as unknown;
    return isRecord(payload) && payload.role === "service_role";
  } catch {
    return false;
  }
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

async function findAndSaveCheckout(
  due: DueCheckout,
  expected: ExpectedCheckout,
  sumup: NonNullable<ReturnType<typeof getSumUpConfig>>,
): Promise<VerifiedCheckout | null> {
  const matches = await findCheckoutByReference(due.checkoutReference, sumup);
  if (matches.length > 1) throw new SumUpError();
  if (matches.length === 0) return null;

  const checkout = parseVerifiedCheckout(matches[0], expected);
  await callRpc<boolean>("save_sumup_checkout", {
    p_order_id: due.orderId,
    p_checkout_id: checkout.checkoutId,
    p_hosted_checkout_url: checkout.hostedCheckoutUrl,
    p_merchant_code: due.merchantCode,
  });
  return checkout;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return response(405, { error: "Use POST for scheduled reconciliation." });
  }
  if (!isTrustedSchedulerRequest(request)) {
    return response(401, { error: "Unauthorized." });
  }

  try {
    await callRpc<number>("release_expired_checkout_reservations", {
      p_batch_size: 100,
    });
    const rawDue = await callRpc<unknown>("get_due_sumup_checkouts", {
      p_batch_size: 50,
    });
    if (!Array.isArray(rawDue)) {
      return response(503, {
        error: "Reconciliation is temporarily unavailable.",
      });
    }
    if (rawDue.length === 0) return response(200, { reconciled: 0 });

    const sumup = getSumUpConfig();
    if (!sumup) {
      return response(503, {
        error: "Sandbox payment configuration is unavailable.",
      });
    }

    let reconciled = 0;
    for (const rawCheckout of rawDue) {
      const due = parseDueCheckout(rawCheckout);
      if (!due || due.merchantCode !== sumup.merchantCode) {
        return response(503, {
          error: "Reconciliation is temporarily unavailable.",
        });
      }

      const expected: ExpectedCheckout = {
        checkoutId: due.checkoutId ?? undefined,
        checkoutReference: due.checkoutReference,
        merchantCode: due.merchantCode,
        amountMinor: due.amountMinor,
        currency: due.currency,
      };
      let checkout: VerifiedCheckout | null;

      if (due.checkoutId) {
        checkout = await retrieveCheckout(due.checkoutId, expected, sumup);
      } else {
        checkout = await findAndSaveCheckout(due, expected, sumup);
        if (!checkout) {
          await callRpc<boolean>("expire_uncreated_sumup_checkout", {
            p_order_id: due.orderId,
          });
          reconciled += 1;
          continue;
        }
      }

      await persistVerification(due.orderId, checkout);
      reconciled += 1;
    }

    await callRpc<number>("release_expired_checkout_reservations", {
      p_batch_size: 100,
    });
    return response(200, { reconciled });
  } catch (error) {
    if (error instanceof SumUpError) {
      return response(503, {
        error: "SumUp reconciliation is temporarily unavailable.",
      });
    }
    return response(503, {
      error: "Reconciliation is temporarily unavailable.",
    });
  }
});
