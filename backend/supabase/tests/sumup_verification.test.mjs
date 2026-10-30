import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVerifiedCheckout,
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
