import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVerifiedCheckout,
  retrieveCheckout,
  SumUpError,
} from "../functions/_shared/sumup.ts";

const expected = {
  checkoutId: "checkout-123",
  checkoutReference: "order-123",
  merchantCode: "MERCHANT123",
  amountMinor: 1025,
  currency: "GBP",
};

function providerCheckout(overrides = {}) {
  return {
    id: expected.checkoutId,
    checkout_reference: expected.checkoutReference,
    merchant_code: expected.merchantCode,
    amount: 10.25,
    currency: expected.currency,
    status: "PENDING",
    hosted_checkout_url: "https://checkout.sumup.com/pay/checkout-123",
    transactions: [],
    ...overrides,
  };
}

test("accepts a paid checkout only with a matching successful transaction", () => {
  const checkout = parseVerifiedCheckout(
    providerCheckout({
      status: "PAID",
      transactions: [{
        id: "transaction-123",
        transaction_code: "CODE123",
        amount: 10.25,
        currency: "GBP",
        status: "SUCCESSFUL",
      }],
    }),
    expected,
  );

  assert.equal(checkout.checkoutStatus, "PAID");
  assert.equal(checkout.transactionStatus, "SUCCESSFUL");
  assert.equal(checkout.transactionReference, "CODE123");
});

test("keeps a failed processing attempt associated with a pending checkout", () => {
  const checkout = parseVerifiedCheckout(
    providerCheckout({
      status: "FAILED",
      transactions: [{ amount: 10.25, currency: "GBP", status: "FAILED" }],
    }),
    expected,
  );

  assert.equal(checkout.checkoutStatus, "FAILED");
  assert.equal(checkout.transactionStatus, "FAILED");
});

test("keeps a cancelled transaction attempt associated with a pending checkout", () => {
  const checkout = parseVerifiedCheckout(
    providerCheckout({
      status: "PENDING",
      transactions: [{ amount: 10.25, currency: "GBP", status: "CANCELLED" }],
    }),
    expected,
  );

  assert.equal(checkout.checkoutStatus, "PENDING");
  assert.equal(checkout.transactionStatus, "CANCELLED");
});

test("rejects a paid checkout without a matching successful transaction", () => {
  assert.throws(
    () => parseVerifiedCheckout(providerCheckout({ status: "PAID" }), expected),
    SumUpError,
  );
});

test("rejects contradictory checkout and transaction success states", () => {
  assert.throws(
    () =>
      parseVerifiedCheckout(
        providerCheckout({
          status: "FAILED",
          transactions: [{
            amount: 10.25,
            currency: "GBP",
            status: "SUCCESSFUL",
          }],
        }),
        expected,
      ),
    SumUpError,
  );
});

test("rejects successful transactions whose amount or currency does not match", () => {
  assert.throws(
    () =>
      parseVerifiedCheckout(
        providerCheckout({
          status: "PAID",
          transactions: [{
            amount: 10.24,
            currency: "GBP",
            status: "SUCCESSFUL",
          }],
        }),
        expected,
      ),
    SumUpError,
  );
});

test("rejects checkout identity, merchant, amount, and currency mismatches", async (t) => {
  const cases = [
    ["checkout ID", providerCheckout(), { ...expected, checkoutId: "other-checkout" }],
    ["checkout reference", providerCheckout({ checkout_reference: "other-reference" }), expected],
    ["merchant", providerCheckout({ merchant_code: "OTHER" }), expected],
    ["amount", providerCheckout({ amount: 10.24 }), expected],
    ["currency", providerCheckout({ currency: "USD" }), expected],
  ];

  for (const [name, checkout, expectedCheckout] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => parseVerifiedCheckout(checkout, expectedCheckout),
        SumUpError,
      );
    });
  }
});

test("rejects malformed provider checkout data", () => {
  assert.throws(() => parseVerifiedCheckout(null, expected), SumUpError);
  assert.throws(() => parseVerifiedCheckout({}, expected), SumUpError);
});

test("logs only the SumUp status and path for failed API responses", async () => {
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const logged = [];
  let requestInit;

  globalThis.fetch = async (_url, init) => {
    requestInit = init;
    return new Response("sensitive provider response", { status: 503 });
  };
  console.error = (...args) => logged.push(args);

  try {
    await assert.rejects(
      retrieveCheckout(
        "checkout-123",
        expected,
        { apiKey: "sumup-secret-test-key", merchantCode: "MERCHANT123" },
      ),
      (error) => error instanceof SumUpError && error.statusCode === 503,
    );

    assert.deepEqual(logged, [[
      "SumUp API request failed",
      { status: 503, path: "/v0.1/checkouts/checkout-123" },
    ]]);
    assert.equal(
      JSON.stringify(logged).includes("sumup-secret-test-key"),
      false,
    );
    assert.equal(
      JSON.stringify(logged).includes(requestInit.headers.authorization),
      false,
    );
    assert.equal(JSON.stringify(logged).includes("sensitive provider response"), false);
  } finally {
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
});
