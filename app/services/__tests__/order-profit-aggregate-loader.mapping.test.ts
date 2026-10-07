import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Decimal } from "../../domain/profit-engine/money.ts";
import {
  mapPersistedOrderToNormalizationSource,
  OrderProfitAggregateLoadError,
} from "../order-profit-aggregate-loader.server.ts";
import type { PersistedOrderAggregate } from "../order-profit-aggregate-loader.server.ts";

// Pure mapping tests: no database access.

const d = (value: string) => new Decimal(value);
const amount = (value: string) => ({ amount: d(value), currencyCode: "EUR" });

type Row = PersistedOrderAggregate;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "order-1",
    shopId: "shop-1",
    currencyCode: "EUR",
    taxesIncluded: false,
    test: false,
    deletedAt: null,
    lines: [
      {
        id: "line-1",
        quantity: 2,
        isGiftCard: false,
        originalTotal: d("100"),
        currencyCode: "EUR",
        discountAllocations: [amount("10"), amount("0")],
        taxes: [amount("18"), amount("1.5")],
        costSnapshot: {
          unitCost: d("40"),
          currencyCode: "EUR",
          source: "SHOPIFY_UNIT_COST",
          historicalApproximation: false,
        },
      },
      {
        id: "line-2",
        quantity: 1,
        isGiftCard: true,
        originalTotal: d("50"),
        currencyCode: "EUR",
        discountAllocations: [],
        taxes: [],
        costSnapshot: null,
      },
    ],
    shippingLines: [
      { isRemoved: false, discountedPrice: d("10"), currencyCode: "EUR", taxes: [amount("2")] },
      { isRemoved: true, discountedPrice: d("25"), currencyCode: "EUR", taxes: [] },
    ],
    transactions: [
      {
        id: "tx-sale",
        refundId: null,
        kind: "SALE",
        status: "SUCCESS",
        gateway: "shopify_payments",
        amount: d("110"),
        currencyCode: "EUR",
        test: false,
        fees: [amount("2.75"), amount("0.25")],
      },
      {
        id: "tx-auth",
        refundId: null,
        kind: "AUTHORIZATION",
        status: "FAILURE",
        gateway: null,
        amount: d("110"),
        currencyCode: "EUR",
        test: true,
        fees: [],
      },
      {
        id: "tx-refund",
        refundId: "refund-1",
        kind: "REFUND",
        status: "PENDING",
        gateway: "shopify_store_credit",
        amount: d("60"),
        currencyCode: "EUR",
        test: false,
        fees: [],
      },
    ],
    refunds: [
      {
        id: "refund-1",
        totalRefunded: d("0"),
        currencyCode: "EUR",
        lines: [
          {
            orderLineId: "line-1",
            quantity: 1,
            subtotal: d("50"),
            taxAmount: d("10"),
            currencyCode: "EUR",
            restockType: "RETURN",
          },
          {
            orderLineId: "line-1",
            quantity: 1,
            subtotal: d("0"),
            taxAmount: d("0"),
            currencyCode: "EUR",
            restockType: "NO_RESTOCK",
          },
        ],
        shippingLines: [{ subtotalAmount: d("10"), taxAmount: d("2"), currencyCode: "EUR" }],
        adjustments: [
          { reason: "REFUND_DISCREPANCY", amount: d("60"), taxAmount: d("0"), currencyCode: "EUR" },
          { reason: "REFUND_DISCREPANCY", amount: d("0"), taxAmount: d("0"), currencyCode: "EUR" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("mapPersistedOrderToNormalizationSource", () => {
  const source = mapPersistedOrderToNormalizationSource(row());

  it("1. maps the order header", () => {
    assert.deepEqual(source.order, { currencyCode: "EUR", taxesIncluded: false, test: false });
  });

  it("2. keeps every order line, gift cards included", () => {
    assert.deepEqual(source.orderLines.map((line) => line.id), ["line-1", "line-2"]);
    assert.equal(source.orderLines[0].quantity, 2);
    assert.equal(source.orderLines[1].isGiftCard, true);
  });

  it("3/4. keeps every discount allocation and tax line, zeros included, unsummed", () => {
    assert.deepEqual(
      source.orderLines[0].discountAllocations.map((item) => item.amount.toString()),
      ["10", "0"],
    );
    assert.deepEqual(source.orderLines[0].taxLines.map((item) => item.amount.toString()), ["18", "1.5"]);
  });

  it("5. null cost snapshot stays null", () => {
    assert.equal(source.orderLines[1].costSnapshot, null);
  });

  it("6. MISSING snapshot keeps its null cost and currency", () => {
    const mapped = mapPersistedOrderToNormalizationSource(
      row({
        lines: [
          {
            ...row().lines[0],
            costSnapshot: { unitCost: null, currencyCode: null, source: "MISSING", historicalApproximation: true },
          },
        ],
        transactions: [],
        refunds: [],
      }),
    );
    assert.deepEqual(mapped.orderLines[0].costSnapshot, {
      unitCost: null,
      currencyCode: null,
      source: "MISSING",
      historicalApproximation: true,
    });
  });

  it("7. keeps active and removed shipping lines", () => {
    assert.deepEqual(source.shippingLines.map((line) => line.isRemoved), [false, true]);
    assert.equal(source.shippingLines[0].taxLines.length, 1);
  });

  it("8. keeps transactions of every kind, status and test flag", () => {
    assert.deepEqual(
      source.transactions.map((transaction) => [transaction.kind, transaction.status, transaction.test]),
      [
        ["SALE", "SUCCESS", false],
        ["AUTHORIZATION", "FAILURE", true],
        ["REFUND", "PENDING", false],
      ],
    );
  });

  it("9. keeps the internal refundId", () => {
    assert.deepEqual(source.transactions.map((transaction) => transaction.refundId), [null, null, "refund-1"]);
    assert.equal(source.refunds[0].id, "refund-1");
  });

  it("10. keeps a null gateway", () => {
    assert.equal(source.transactions[1].gateway, null);
  });

  it("11. keeps every fee row", () => {
    assert.deepEqual(source.transactions[0].fees.map((fee) => fee.amount.toString()), ["2.75", "0.25"]);
  });

  it("12/13/14. keeps refund lines, refund shipping lines and every adjustment", () => {
    const refund = source.refunds[0];
    assert.equal(refund.lines.length, 2);
    assert.deepEqual(refund.lines.map((line) => line.restockType), ["RETURN", "NO_RESTOCK"]);
    assert.equal(refund.lines[0].orderLineId, "line-1");
    assert.equal(refund.shippingLines.length, 1);
    assert.deepEqual(refund.adjustments.map((item) => item.amount.toString()), ["60", "0"]);
  });

  it("15. every amount stays the same Decimal instance", () => {
    const original = row();
    const mapped = mapPersistedOrderToNormalizationSource(original);
    assert.equal(mapped.orderLines[0].originalTotal, original.lines[0].originalTotal);
    assert.equal(mapped.transactions[0].amount, original.transactions[0].amount);
    assert.equal(mapped.refunds[0].totalRefunded, original.refunds[0].totalRefunded);
    assert.ok(Decimal.isDecimal(mapped.shippingLines[0].discountedPrice));
  });

  it("16. null values stay null", () => {
    assert.equal(source.transactions[0].refundId, null);
    assert.equal(source.transactions[1].gateway, null);
    assert.equal(source.orderLines[1].costSnapshot, null);
  });

  it("17. output has no catalog, shop or customer field", () => {
    const keys = new Set<string>();
    collectKeys(source, keys);
    for (const forbidden of ["productId", "variantId", "inventoryItem", "shopId", "customerShopifyGid", "rate", "type"]) {
      assert.ok(!keys.has(forbidden), forbidden);
    }
  });

  it("rejects a transaction linked to a refund of another order", () => {
    assert.throws(
      () =>
        mapPersistedOrderToNormalizationSource(
          row({ transactions: [{ ...row().transactions[2], refundId: "refund-of-other-order" }] }),
        ),
      (error: unknown) =>
        error instanceof OrderProfitAggregateLoadError && error.code === "INCONSISTENT_PERSISTED_DATA",
    );
  });

  it("rejects a refund line linked to an order line of another order", () => {
    const refund = row().refunds[0];
    assert.throws(
      () =>
        mapPersistedOrderToNormalizationSource(
          row({ refunds: [{ ...refund, lines: [{ ...refund.lines[0], orderLineId: "other-line" }] }] }),
        ),
      (error: unknown) =>
        error instanceof OrderProfitAggregateLoadError && error.code === "INCONSISTENT_PERSISTED_DATA",
    );
  });
});

function collectKeys(value: unknown, keys: Set<string>): void {
  if (typeof value !== "object" || value === null || Decimal.isDecimal(value)) return;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
}
