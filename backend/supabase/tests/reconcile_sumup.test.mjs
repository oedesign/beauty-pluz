import assert from "node:assert/strict";
import test from "node:test";
import {
  hasAuthorizedReconciliationRequest,
  reconcileDueCheckouts,
} from "../functions/_shared/reconciliation.mjs";

class MockSumUpError extends Error {}

const merchantCode = "TESTMERCHANT";

function dueCheckout(overrides = {}) {
  return {
    orderId: "order-test",
    checkoutReference: "reference-test",
    checkoutId: "checkout-test",
    state: "pending",
    merchantCode,
    amountMinor: 1250,
    currency: "GBP",
    ...overrides,
  };
}

function providerCheckout(overrides = {}) {
  return {
    checkoutId: "checkout-test",
    checkoutReference: "reference-test",
    merchantCode,
    checkoutStatus: "PENDING",
    transactionStatus: "PENDING",
    amountMinor: 1250,
    currency: "GBP",
    transactionReference: null,
    hostedCheckoutUrl: "https://checkout.sumup.com/pay/test",
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    merchantCode,
    sumup: {},
    SumUpError: MockSumUpError,
    parseDueCheckout: (value) => value,
    retrieveCheckout: async () => providerCheckout(),
    findCheckoutByReference: async () => [providerCheckout()],
    parseVerifiedCheckout: (value) => value,
    callRpc: async () => true,
    persistVerification: async (_orderId, checkout) =>
      checkout.checkoutStatus === "PAID" ? "paid" : "pending",
    ...overrides,
  };
}

const reconciliationSecret = "a".repeat(64);

test("accepts the configured 256-bit hexadecimal reconciliation secret", () => {
  assert.equal(
    hasAuthorizedReconciliationRequest(
      reconciliationSecret,
      reconciliationSecret,
    ),
    true,
  );
});

test("rejects incorrect, absent, or malformed reconciliation secrets", () => {
  assert.equal(
    hasAuthorizedReconciliationRequest("b".repeat(64), reconciliationSecret),
    false,
  );
  assert.equal(
    hasAuthorizedReconciliationRequest(null, reconciliationSecret),
    false,
  );
  assert.equal(
    hasAuthorizedReconciliationRequest("a".repeat(63), reconciliationSecret),
    false,
  );
  assert.equal(
    hasAuthorizedReconciliationRequest("z".repeat(64), reconciliationSecret),
    false,
  );
  assert.equal(
    hasAuthorizedReconciliationRequest(
      reconciliationSecret,
      "not-a-256-bit-hex-secret",
    ),
    false,
  );
});

test("counts a verified successful payment", async () => {
  const result = await reconcileDueCheckouts(
    [dueCheckout()],
    dependencies({
      retrieveCheckout: async () => providerCheckout({
        checkoutStatus: "PAID",
        transactionStatus: "SUCCESSFUL",
        transactionReference: "transaction-test",
      }),
      persistVerification: async () => "paid",
    }),
  );

  assert.deepEqual(result, {
    examined: 1,
    paid: 1,
    pending: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    errors: 0,
    providerErrors: 0,
  });
});

test("keeps pending, failed-attempt, and cancelled-attempt checkouts pending", async () => {
  const inputs = [
    providerCheckout(),
    providerCheckout({
      checkoutStatus: "FAILED",
      transactionStatus: "FAILED",
    }),
    providerCheckout({ transactionStatus: "CANCELLED" }),
  ];
  let index = 0;
  const result = await reconcileDueCheckouts(
    inputs.map((_, inputIndex) => dueCheckout({ orderId: `order-${inputIndex}` })),
    dependencies({
      retrieveCheckout: async () => inputs[index++],
      persistVerification: async () => "pending",
    }),
  );

  assert.equal(result.pending, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.errors, 0);
});

test("counts an expired provider checkout", async () => {
  const result = await reconcileDueCheckouts(
    [dueCheckout()],
    dependencies({
      retrieveCheckout: async () => providerCheckout({
        checkoutStatus: "EXPIRED",
        transactionStatus: null,
      }),
      persistVerification: async () => "expired",
    }),
  );

  assert.equal(result.expired, 1);
  assert.equal(result.errors, 0);
});

test("rejects malformed, amount-mismatched, and currency-mismatched provider responses", async (t) => {
  const cases = [
    ["invalid response", () => { throw new MockSumUpError(); }],
    ["amount mismatch", (value, expected) => {
      if (value.amountMinor !== expected.amountMinor) throw new MockSumUpError();
      return value;
    }, { amountMinor: 1249 }],
    ["currency mismatch", (value, expected) => {
      if (value.currency !== expected.currency) throw new MockSumUpError();
      return value;
    }, { currency: "USD" }],
  ];
  for (const [name, parseVerifiedCheckout, providerOverrides] of cases) {
    await t.test(name, async () => {
      let persisted = false;
      const result = await reconcileDueCheckouts(
        [dueCheckout({ checkoutId: null, state: "creating" })],
        dependencies({
          findCheckoutByReference: async () => [
            providerCheckout(providerOverrides),
          ],
          parseVerifiedCheckout,
          persistVerification: async () => {
            persisted = true;
            return "paid";
          },
        }),
      );

      assert.equal(result.errors, 1);
      assert.equal(result.providerErrors, 1);
      assert.equal(persisted, false);
    });
  }
});

test("rejects a checkout whose merchant does not match configured SumUp", async () => {
  let retrieved = false;
  const result = await reconcileDueCheckouts(
    [dueCheckout({ merchantCode: "OTHER" })],
    dependencies({
      retrieveCheckout: async () => {
        retrieved = true;
        return providerCheckout();
      },
    }),
  );

  assert.equal(result.errors, 1);
  assert.equal(retrieved, false);
});

test("does not expire or release inventory after a temporary provider failure", async () => {
  let expireCalled = false;
  const result = await reconcileDueCheckouts(
    [dueCheckout({ checkoutId: null, state: "creating" })],
    dependencies({
      findCheckoutByReference: async () => {
        throw new MockSumUpError();
      },
      callRpc: async () => {
        expireCalled = true;
        return true;
      },
    }),
  );

  assert.equal(result.errors, 1);
  assert.equal(result.providerErrors, 1);
  assert.equal(expireCalled, false);
});

test("continues processing other checkouts after one provider failure", async () => {
  const result = await reconcileDueCheckouts(
    [
      dueCheckout({ orderId: "bad-order", checkoutId: "bad-checkout" }),
      dueCheckout({ orderId: "good-order", checkoutId: "good-checkout" }),
    ],
    dependencies({
      retrieveCheckout: async (id) => {
        if (id === "bad-checkout") throw new MockSumUpError();
        return providerCheckout({ checkoutStatus: "PAID" });
      },
      persistVerification: async () => "paid",
    }),
  );

  assert.equal(result.examined, 2);
  assert.equal(result.errors, 1);
  assert.equal(result.providerErrors, 1);
  assert.equal(result.paid, 1);
});

test("repeated invocations preserve the database's idempotent stock-consumption contract", async () => {
  let paymentState = "pending";
  let stock = 4;
  const persistVerification = async () => {
    if (paymentState !== "paid") {
      paymentState = "paid";
      stock -= 1;
    }
    return paymentState;
  };
  const deps = dependencies({
    retrieveCheckout: async () => providerCheckout({
      checkoutStatus: "PAID",
      transactionStatus: "SUCCESSFUL",
    }),
    persistVerification,
  });

  await reconcileDueCheckouts([dueCheckout()], deps);
  await reconcileDueCheckouts([dueCheckout()], deps);

  assert.equal(paymentState, "paid");
  assert.equal(stock, 3);
});

test("expires an uncreated checkout only when the database confirms expiry", async () => {
  const expiredResult = await reconcileDueCheckouts(
    [dueCheckout({ checkoutId: null, state: "creating" })],
    dependencies({
      findCheckoutByReference: async () => [],
      callRpc: async () => true,
    }),
  );
  const stillActiveResult = await reconcileDueCheckouts(
    [dueCheckout({ checkoutId: null, state: "creating" })],
    dependencies({
      findCheckoutByReference: async () => [],
      callRpc: async () => false,
    }),
  );

  assert.equal(expiredResult.expired, 1);
  assert.equal(stillActiveResult.pending, 1);
});
