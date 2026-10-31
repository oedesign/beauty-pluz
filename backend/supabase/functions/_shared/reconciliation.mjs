export function hasServiceRoleClaim(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3 || !parts[1]) return false;

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      atob(base64 + "=".repeat((4 - base64.length % 4) % 4)),
    );
    return payload !== null &&
      typeof payload === "object" &&
      payload.role === "service_role";
  } catch {
    return false;
  }
}

function createCounts(examined) {
  return {
    examined,
    paid: 0,
    pending: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    errors: 0,
    providerErrors: 0,
  };
}

function recordPaymentResult(counts, paymentStatus, checkout) {
  if (paymentStatus === "paid") {
    counts.paid += 1;
    return;
  }
  if (paymentStatus === "pending") {
    counts.pending += 1;
    if (
      checkout.checkoutStatus === "FAILED" ||
      checkout.transactionStatus === "FAILED"
    ) counts.failed += 1;
    if (checkout.transactionStatus === "CANCELLED") counts.cancelled += 1;
    return;
  }
  if (paymentStatus === "failed") {
    counts.failed += 1;
    return;
  }
  if (paymentStatus === "cancelled") {
    counts.cancelled += 1;
    return;
  }
  if (paymentStatus === "expired") {
    counts.expired += 1;
    return;
  }
  counts.errors += 1;
}

async function reconcileOne(rawCheckout, counts, dependencies) {
  try {
    const due = dependencies.parseDueCheckout(rawCheckout);
    if (
      !due ||
      !["creating", "pending"].includes(due.state) ||
      due.merchantCode !== dependencies.merchantCode
    ) {
      counts.errors += 1;
      return;
    }

    const expected = {
      checkoutId: due.checkoutId ?? undefined,
      checkoutReference: due.checkoutReference,
      merchantCode: due.merchantCode,
      amountMinor: due.amountMinor,
      currency: due.currency,
    };
    let checkout;
    if (due.checkoutId) {
      checkout = await dependencies.retrieveCheckout(
        due.checkoutId,
        expected,
        dependencies.sumup,
      );
    } else {
      const matches = await dependencies.findCheckoutByReference(
        due.checkoutReference,
        dependencies.sumup,
      );
      if (!Array.isArray(matches) || matches.length > 1) {
        throw new dependencies.SumUpError();
      }
      if (matches.length === 0) {
        const expired = await dependencies.callRpc(
          "expire_uncreated_sumup_checkout",
          { p_order_id: due.orderId },
        );
        if (expired === true) counts.expired += 1;
        else counts.pending += 1;
        return;
      }

      checkout = dependencies.parseVerifiedCheckout(matches[0], expected);
      await dependencies.callRpc("save_sumup_checkout", {
        p_order_id: due.orderId,
        p_checkout_id: checkout.checkoutId,
        p_hosted_checkout_url: checkout.hostedCheckoutUrl,
        p_merchant_code: due.merchantCode,
      });
    }

    const paymentStatus = await dependencies.persistVerification(
      due.orderId,
      checkout,
    );
    recordPaymentResult(counts, paymentStatus, checkout);
  } catch (error) {
    counts.errors += 1;
    if (error instanceof dependencies.SumUpError) {
      counts.providerErrors += 1;
    }
  }
}

export async function reconcileDueCheckouts(rawCheckouts, dependencies) {
  const counts = createCounts(rawCheckouts.length);
  let nextIndex = 0;
  const workerCount = Math.min(2, rawCheckouts.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < rawCheckouts.length) {
      const index = nextIndex;
      nextIndex += 1;
      await reconcileOne(rawCheckouts[index], counts, dependencies);
    }
  });
  await Promise.all(workers);
  return counts;
}
