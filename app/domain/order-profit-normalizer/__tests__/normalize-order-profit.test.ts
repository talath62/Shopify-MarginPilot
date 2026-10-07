import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Decimal } from "../../profit-engine/money.ts";
import { calculateOrderProfit } from "../../profit-engine/index.ts";
import type { FinancialValue, OrderProfitInput } from "../../profit-engine/index.ts";
import { normalizeOrderProfitInput, OrderProfitNormalizationError } from "../index.ts";
import type {
  ExternalProfitCosts,
  OrderProfitNormalizationSource,
  SourceAmount,
  SourceCostSnapshot,
  SourceOrderLine,
  SourceRefund,
  SourceRefundLine,
  SourceShippingLine,
  SourceTransaction,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Builders. Amounts use the default Prisma Decimal, like a DB loader would.
// ---------------------------------------------------------------------------

const d = (value: string) => new Decimal(value);
const eur = (amount: string, currencyCode = "EUR"): SourceAmount => ({
  amount: d(amount),
  currencyCode,
});
const verified = (amount: string): FinancialValue => ({ status: "verified", amount: d(amount) });
const estimated = (amount: string): FinancialValue => ({ status: "estimated", amount: d(amount) });
const missing: FinancialValue = { status: "missing", amount: null };

function snapshot(overrides: Partial<SourceCostSnapshot> = {}): SourceCostSnapshot {
  return {
    unitCost: d("40"),
    currencyCode: "EUR",
    source: "SHOPIFY_UNIT_COST",
    historicalApproximation: false,
    ...overrides,
  };
}

function line(overrides: Partial<SourceOrderLine> = {}): SourceOrderLine {
  return {
    id: "line-1",
    quantity: 1,
    isGiftCard: false,
    originalTotal: d("100"),
    currencyCode: "EUR",
    discountAllocations: [],
    taxLines: [],
    costSnapshot: snapshot(),
    ...overrides,
  };
}

function shipping(overrides: Partial<SourceShippingLine> = {}): SourceShippingLine {
  return {
    isRemoved: false,
    discountedPrice: d("10"),
    currencyCode: "EUR",
    taxLines: [],
    ...overrides,
  };
}

function transaction(overrides: Partial<SourceTransaction> = {}): SourceTransaction {
  return {
    id: "tx-sale",
    refundId: null,
    kind: "SALE",
    status: "SUCCESS",
    gateway: "shopify_payments",
    amount: d("110"),
    currencyCode: "EUR",
    test: false,
    fees: [eur("3")],
    ...overrides,
  };
}

function refundLine(overrides: Partial<SourceRefundLine> = {}): SourceRefundLine {
  return {
    orderLineId: "line-1",
    quantity: 1,
    subtotal: d("50"),
    taxAmount: d("10"),
    currencyCode: "EUR",
    restockType: "RETURN",
    ...overrides,
  };
}

function refund(overrides: Partial<SourceRefund> = {}): SourceRefund {
  return {
    id: "refund-1",
    totalRefunded: d("60"),
    currencyCode: "EUR",
    lines: [refundLine()],
    shippingLines: [],
    adjustments: [],
    ...overrides,
  };
}

function refundTransaction(overrides: Partial<SourceTransaction> = {}): SourceTransaction {
  return transaction({
    id: "tx-refund",
    refundId: "refund-1",
    kind: "REFUND",
    status: "SUCCESS",
    amount: d("60"),
    fees: [],
    ...overrides,
  });
}

/** PG-003 reference case (spec §49). */
function referenceSource(
  overrides: Partial<OrderProfitNormalizationSource> = {},
): OrderProfitNormalizationSource {
  return {
    order: { currencyCode: "EUR", taxesIncluded: false, test: false },
    orderLines: [
      line({ discountAllocations: [eur("10")], taxLines: [eur("18")] }),
    ],
    shippingLines: [shipping({ taxLines: [eur("2")] })],
    transactions: [transaction()],
    refunds: [],
    ...overrides,
  };
}

const referenceExternal: ExternalProfitCosts = {
  shippingCost: verified("5"),
  adCost: verified("20"),
  otherCosts: verified("2"),
};

function withOrder(
  order: Partial<OrderProfitNormalizationSource["order"]>,
  overrides: Partial<OrderProfitNormalizationSource> = {},
): OrderProfitNormalizationSource {
  const base = referenceSource(overrides);
  return { ...base, order: { ...base.order, ...order } };
}

function assertDecimal(actual: Decimal, expected: string) {
  assert.equal(actual.toString(), expected);
}

function assertValue(actual: FinancialValue, status: FinancialValue["status"], amount: string | null) {
  assert.equal(actual.status, status);
  if (amount === null) assert.equal(actual.amount, null);
  else {
    assert.ok(actual.amount !== null);
    assert.equal(actual.amount.toString(), amount);
  }
}

function assertNormalizationError(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof OrderProfitNormalizationError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

const normalize = (
  source: OrderProfitNormalizationSource,
  external: ExternalProfitCosts = referenceExternal,
) => normalizeOrderProfitInput(source, external);

// ---------------------------------------------------------------------------

describe("reference case (spec §49) and PG-002 integration", () => {
  it("normalizes the reference order", () => {
    const input = normalize(referenceSource());
    assert.equal(input.currency, "EUR");
    assertDecimal(input.productRevenueExTax, "90");
    assertDecimal(input.shippingRevenueExTax, "10");
    assertDecimal(input.economicRefundsExTax, "0");
    assertValue(input.cogs, "verified", "40");
    assertValue(input.shippingCost, "verified", "5");
    assertValue(input.paymentFees, "verified", "3");
    assertValue(input.adCost, "verified", "20");
    assertValue(input.otherCosts, "verified", "2");
  });

  it("output is accepted by calculateOrderProfit without adaptation", () => {
    const result = calculateOrderProfit(normalize(referenceSource()), {
      lowMarginThresholdPercent: d("10"),
    });
    // 100 - 10 + 10 = 100 ; costs 40 + 5 + 3 + 2 = 50 ; ads 20
    assertDecimal(result.netRevenue, "100");
    assert.ok(result.profitBeforeAds !== null && result.profit !== null);
    assertDecimal(result.profitBeforeAds, "50");
    assertDecimal(result.profit, "30");
    assert.equal(result.completeness, "complete");
    assert.equal(result.profitabilityState, "PROFITABLE");
  });

  it("missing external costs flow into an INCOMPLETE engine result", () => {
    const result = calculateOrderProfit(normalizeOrderProfitInput(referenceSource()), {
      lowMarginThresholdPercent: d("10"),
    });
    assert.equal(result.profit, null);
    assert.equal(result.completeness, "incomplete");
    assert.equal(result.profitabilityState, "INCOMPLETE");
  });
});

describe("product and shipping revenue", () => {
  it("1. one product line without discount, taxes excluded", () => {
    const input = normalize(referenceSource({ orderLines: [line()] }));
    assertDecimal(input.productRevenueExTax, "100");
  });

  it("2. several product lines", () => {
    const input = normalize(
      referenceSource({
        orderLines: [
          line(),
          line({ id: "line-2", originalTotal: d("49.99"), discountAllocations: [eur("4.99")] }),
        ],
      }),
    );
    assertDecimal(input.productRevenueExTax, "145");
  });

  it("3. gift card line excluded from product revenue", () => {
    const input = normalize(
      referenceSource({
        orderLines: [
          line(),
          line({ id: "gift", isGiftCard: true, originalTotal: d("50"), costSnapshot: null }),
        ],
      }),
    );
    assertDecimal(input.productRevenueExTax, "100");
  });

  it("4. single discount allocation", () => {
    const input = normalize(referenceSource({ orderLines: [line({ discountAllocations: [eur("15")] })] }));
    assertDecimal(input.productRevenueExTax, "85");
  });

  it("5. several discount allocations", () => {
    const input = normalize(
      referenceSource({
        orderLines: [line({ discountAllocations: [eur("10"), eur("5.5"), eur("0.25")] })],
      }),
    );
    assertDecimal(input.productRevenueExTax, "84.25");
  });

  it("6. taxesIncluded=false: taxes present but not subtracted", () => {
    const input = normalize(referenceSource({ orderLines: [line({ taxLines: [eur("20")] })] }));
    assertDecimal(input.productRevenueExTax, "100");
  });

  it("7. taxesIncluded=true: line taxes subtracted", () => {
    const input = normalize(
      withOrder(
        { taxesIncluded: true },
        { orderLines: [line({ originalTotal: d("120"), taxLines: [eur("20")] })] },
      ),
    );
    assertDecimal(input.productRevenueExTax, "100");
  });

  it("8. active shipping line included", () => {
    const input = normalize(referenceSource({ shippingLines: [shipping({ discountedPrice: d("7.9") })] }));
    assertDecimal(input.shippingRevenueExTax, "7.9");
  });

  it("9. removed shipping line excluded", () => {
    const input = normalize(
      referenceSource({
        shippingLines: [shipping(), shipping({ isRemoved: true, discountedPrice: d("25") })],
      }),
    );
    assertDecimal(input.shippingRevenueExTax, "10");
  });

  it("10. free shipping gives 0 revenue and never a shipping cost", () => {
    const input = normalizeOrderProfitInput(
      referenceSource({ shippingLines: [shipping({ discountedPrice: d("0") })] }),
    );
    assertDecimal(input.shippingRevenueExTax, "0");
    assertValue(input.shippingCost, "missing", null);
  });

  it("11. shipping taxes subtracted when taxesIncluded=true", () => {
    const input = normalize(
      withOrder(
        { taxesIncluded: true },
        { shippingLines: [shipping({ discountedPrice: d("12"), taxLines: [eur("2")] })] },
      ),
    );
    assertDecimal(input.shippingRevenueExTax, "10");
  });

  it("12. revenue comes from lines only: Shopify totals are not part of the source", () => {
    // The source type has no Order total field. Adding one changes nothing.
    const source = referenceSource();
    const withTotals = {
      ...source,
      order: { ...source.order, totalPrice: d("9999"), totalDiscounts: d("9999") },
    } as OrderProfitNormalizationSource;
    const input = normalize(withTotals);
    assertDecimal(input.productRevenueExTax, "90");
    assertDecimal(input.shippingRevenueExTax, "10");
  });

  it("discounts larger than the line total are rejected", () => {
    assertNormalizationError(
      () => normalize(referenceSource({ orderLines: [line({ discountAllocations: [eur("100.01")] })] })),
      "INVALID_DISCOUNT",
    );
  });

  it("negative discount, tax or price is rejected", () => {
    assertNormalizationError(
      () => normalize(referenceSource({ orderLines: [line({ discountAllocations: [eur("-1")] })] })),
      "NEGATIVE_AMOUNT",
    );
    assertNormalizationError(
      () => normalize(referenceSource({ orderLines: [line({ taxLines: [eur("-1")] })] })),
      "NEGATIVE_AMOUNT",
    );
    assertNormalizationError(
      () => normalize(referenceSource({ orderLines: [line({ originalTotal: d("-1") })] })),
      "NEGATIVE_AMOUNT",
    );
  });
});

describe("economic refunds", () => {
  it("13. no refund: 0", () => {
    assertDecimal(normalize(referenceSource()).economicRefundsExTax, "0");
  });

  it("14. refund without any REFUND transaction: 0", () => {
    const input = normalize(referenceSource({ refunds: [refund()] }));
    assertDecimal(input.economicRefundsExTax, "0");
  });

  for (const status of ["PENDING", "AWAITING_RESPONSE", "UNKNOWN", "FAILURE", "ERROR"]) {
    it(`15/16. REFUND ${status} only: 0`, () => {
      const input = normalize(
        referenceSource({
          refunds: [refund()],
          transactions: [transaction(), refundTransaction({ status })],
        }),
      );
      assertDecimal(input.economicRefundsExTax, "0");
    });
  }

  it("17. REFUND SUCCESS cash: counted excluding tax", () => {
    const input = normalize(
      referenceSource({
        refunds: [refund()],
        transactions: [transaction(), refundTransaction({ gateway: "shopify_payments" })],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "50");
  });

  it("18. REFUND SUCCESS store credit: counted", () => {
    const input = normalize(
      referenceSource({
        refunds: [refund()],
        transactions: [transaction(), refundTransaction({ gateway: "shopify_store_credit" })],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "50");
  });

  it("refund shipping lines are part of the economic refund", () => {
    const input = normalize(
      referenceSource({
        refunds: [
          refund({
            totalRefunded: d("72"),
            shippingLines: [{ subtotalAmount: d("10"), taxAmount: d("2"), currencyCode: "EUR" }],
          }),
        ],
        transactions: [transaction(), refundTransaction({ amount: d("72") })],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "60");
  });

  it("19. SUGGESTED_REFUND is ignored", () => {
    const input = normalize(
      referenceSource({
        refunds: [refund()],
        transactions: [transaction(), refundTransaction({ kind: "SUGGESTED_REFUND", refundId: null })],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "0");
  });

  it("20. test transaction ignored, test order rejected", () => {
    const input = normalize(
      referenceSource({
        refunds: [refund()],
        transactions: [transaction(), refundTransaction({ test: true })],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "0");
    assertNormalizationError(
      () => normalize(withOrder({ test: true })),
      "TEST_ORDER_NOT_NORMALIZABLE",
    );
  });

  it("21. REFUND SUCCESS with taxesIncluded=true is unresolved ([NC])", () => {
    assertNormalizationError(
      () =>
        normalize(
          withOrder(
            { taxesIncluded: true },
            { refunds: [refund()], transactions: [transaction(), refundTransaction()] },
          ),
        ),
      "UNRESOLVED_TAX_INCLUDED_REFUND",
    );
  });

  it("taxesIncluded=true with an unrealized refund is still normalizable", () => {
    const input = normalize(
      withOrder(
        { taxesIncluded: true },
        { refunds: [refund()], transactions: [transaction(), refundTransaction({ status: "PENDING" })] },
      ),
    );
    assertDecimal(input.economicRefundsExTax, "0");
  });

  it("22. realized refund with a non-zero adjustment is unresolved", () => {
    assertNormalizationError(
      () =>
        normalize(
          referenceSource({
            refunds: [
              refund({
                adjustments: [
                  { reason: "REFUND_DISCREPANCY", amount: d("5"), taxAmount: d("0"), currencyCode: "EUR" },
                ],
              }),
            ],
            transactions: [transaction(), refundTransaction()],
          }),
        ),
      "UNRESOLVED_REFUND_ADJUSTMENT",
    );
  });

  it("23. SUCCESS and PENDING on the same refund are ambiguous", () => {
    assertNormalizationError(
      () =>
        normalize(
          referenceSource({
            refunds: [refund()],
            transactions: [
              transaction(),
              refundTransaction({ amount: d("30") }),
              refundTransaction({ id: "tx-refund-2", status: "PENDING", amount: d("30") }),
            ],
          }),
        ),
      "AMBIGUOUS_PARTIAL_REFUND",
    );
  });

  it("SUCCESS amount that does not match the refund lines is ambiguous", () => {
    assertNormalizationError(
      () =>
        normalize(
          referenceSource({
            refunds: [refund()],
            transactions: [transaction(), refundTransaction({ amount: d("40") })],
          }),
        ),
      "AMBIGUOUS_PARTIAL_REFUND",
    );
  });

  it("two SUCCESS transactions that reconcile the refund are counted once", () => {
    const input = normalize(
      referenceSource({
        refunds: [refund()],
        transactions: [
          transaction(),
          refundTransaction({ amount: d("35") }),
          refundTransaction({ id: "tx-refund-2", amount: d("25"), gateway: "shopify_store_credit" }),
        ],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "50");
  });

  it("a failed retry next to the SUCCESS does not block the refund", () => {
    const input = normalize(
      referenceSource({
        refunds: [refund()],
        transactions: [
          transaction(),
          refundTransaction({ id: "tx-failed", status: "FAILURE" }),
          refundTransaction(),
        ],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "50");
  });

  it("24. totalRefunded is a control, never the source amount", () => {
    // Subtotal 50 HT, tax 10: money moved 60, economic refund stays 50.
    const input = normalize(
      referenceSource({ refunds: [refund()], transactions: [transaction(), refundTransaction()] }),
    );
    assertDecimal(input.economicRefundsExTax, "50");
    // A control total that disagrees is reported, not used.
    assertNormalizationError(
      () =>
        normalize(
          referenceSource({
            refunds: [refund({ totalRefunded: d("55") })],
            transactions: [transaction(), refundTransaction()],
          }),
        ),
      "REFUND_TOTAL_MISMATCH",
    );
  });

  it("realized refund of a gift card line is unresolved", () => {
    assertNormalizationError(
      () =>
        normalize(
          referenceSource({
            orderLines: [line(), line({ id: "gift", isGiftCard: true, costSnapshot: null })],
            refunds: [refund({ lines: [refundLine({ orderLineId: "gift" })] })],
            transactions: [transaction(), refundTransaction()],
          }),
        ),
      "UNRESOLVED_GIFT_CARD_REFUND",
    );
  });

  it("REFUND transaction not linked to a refund is rejected", () => {
    assertNormalizationError(
      () => normalize(referenceSource({ transactions: [transaction(), refundTransaction({ refundId: null })] })),
      "INCONSISTENT_AGGREGATE",
    );
  });
});

describe("COGS", () => {
  it("25. simple verified COGS", () => {
    assertValue(normalize(referenceSource()).cogs, "verified", "40");
  });

  it("26. several lines with quantities", () => {
    const input = normalize(
      referenceSource({
        orderLines: [
          line({ quantity: 3, costSnapshot: snapshot({ unitCost: d("12.5") }) }),
          line({ id: "line-2", quantity: 2, costSnapshot: snapshot({ unitCost: d("0.333333") }) }),
        ],
      }),
    );
    assertValue(input.cogs, "verified", "38.166666");
  });

  it("27. missing snapshot or MISSING source: COGS missing", () => {
    for (const costSnapshot of [null, snapshot({ source: "MISSING", unitCost: null, currencyCode: null })]) {
      const input = normalize(referenceSource({ orderLines: [line(), line({ id: "line-2", costSnapshot })] }));
      assertValue(input.cogs, "missing", null);
    }
  });

  it("28. ESTIMATED source: estimated", () => {
    const input = normalize(referenceSource({ orderLines: [line({ costSnapshot: snapshot({ source: "ESTIMATED" }) })] }));
    assertValue(input.cogs, "estimated", "40");
  });

  it("29. SHOPIFY_UNIT_COST not historical: verified", () => {
    assertValue(normalize(referenceSource()).cogs, "verified", "40");
  });

  it("30. SHOPIFY_UNIT_COST with historicalApproximation: estimated", () => {
    const input = normalize(
      referenceSource({ orderLines: [line({ costSnapshot: snapshot({ historicalApproximation: true }) })] }),
    );
    assertValue(input.cogs, "estimated", "40");
  });

  for (const historicalApproximation of [false, true]) {
    it(`31. MANUAL + historicalApproximation=${historicalApproximation}: verified`, () => {
      const input = normalize(
        referenceSource({
          orderLines: [line({ costSnapshot: snapshot({ source: "MANUAL", historicalApproximation }) })],
        }),
      );
      assertValue(input.cogs, "verified", "40");
    });
  }

  it("32. gift card excluded from COGS, even without snapshot", () => {
    const input = normalize(
      referenceSource({
        orderLines: [line(), line({ id: "gift", isGiftCard: true, costSnapshot: null })],
      }),
    );
    assertValue(input.cogs, "verified", "40");
  });

  for (const restockType of ["RETURN", "CANCEL"]) {
    it(`33/34. ${restockType} gives back the COGS of the returned quantity`, () => {
      const input = normalize(
        referenceSource({
          orderLines: [line({ quantity: 3 })],
          refunds: [refund({ lines: [refundLine({ quantity: 2, restockType })] })],
        }),
      );
      assertValue(input.cogs, "verified", "40");
    });
  }

  it("35. NO_RESTOCK keeps the COGS", () => {
    const input = normalize(
      referenceSource({
        orderLines: [line({ quantity: 3 })],
        refunds: [refund({ lines: [refundLine({ quantity: 2, restockType: "NO_RESTOCK" })] })],
      }),
    );
    assertValue(input.cogs, "verified", "120");
  });

  it("36. physical return with a PENDING refund still reduces COGS", () => {
    const input = normalize(
      referenceSource({
        orderLines: [line({ quantity: 2 })],
        refunds: [refund()],
        transactions: [transaction(), refundTransaction({ status: "PENDING" })],
      }),
    );
    assertDecimal(input.economicRefundsExTax, "0");
    assertValue(input.cogs, "verified", "40");
  });

  it("37. returned quantity above ordered quantity is rejected", () => {
    assertNormalizationError(
      () =>
        normalize(
          referenceSource({
            orderLines: [line({ quantity: 2 })],
            refunds: [
              refund({ lines: [refundLine({ quantity: 2 })] }),
              refund({ id: "refund-2", lines: [refundLine({ quantity: 1, restockType: "CANCEL" })] }),
            ],
          }),
        ),
      "INVALID_RETURN_QUANTITY",
    );
  });

  it("38. verified unitCost 0 stays verified 0", () => {
    const input = normalize(referenceSource({ orderLines: [line({ costSnapshot: snapshot({ unitCost: d("0") }) })] }));
    assertValue(input.cogs, "verified", "0");
  });

  it("39. only the snapshot is read: the source has no current inventory cost", () => {
    // Even with a (foreign) current cost attached, the snapshot cost is used.
    const withCurrentCost = line({ costSnapshot: snapshot({ unitCost: d("40") }) }) as SourceOrderLine & {
      inventoryItemUnitCost: Decimal;
    };
    withCurrentCost.inventoryItemUnitCost = d("999");
    const input = normalize(referenceSource({ orderLines: [withCurrentCost] }));
    assertValue(input.cogs, "verified", "40");
  });

  it("unknown restock type is rejected", () => {
    assertNormalizationError(
      () => normalize(referenceSource({ refunds: [refund({ lines: [refundLine({ restockType: "LEGACY_RESTOCK" })] })] })),
      "UNKNOWN_RESTOCK_TYPE",
    );
  });

  it("refund line pointing to an unknown order line is rejected", () => {
    assertNormalizationError(
      () => normalize(referenceSource({ refunds: [refund({ lines: [refundLine({ orderLineId: "nope" })] })] })),
      "INCONSISTENT_AGGREGATE",
    );
  });

  it("non-integer quantity is rejected", () => {
    assertNormalizationError(
      () => normalize(referenceSource({ orderLines: [line({ quantity: 1.5 })] })),
      "INVALID_QUANTITY",
    );
  });
});

describe("payment fees", () => {
  it("40. SALE SUCCESS Shopify Payments with fees: verified", () => {
    const input = normalize(referenceSource({ transactions: [transaction({ fees: [eur("2.5"), eur("0.25")] })] }));
    assertValue(input.paymentFees, "verified", "2.75");
  });

  it("41. CAPTURE SUCCESS with fees: verified", () => {
    const input = normalize(
      referenceSource({
        transactions: [
          transaction({ id: "auth", kind: "AUTHORIZATION", fees: [] }),
          transaction({ id: "capture", kind: "CAPTURE", fees: [eur("3.1")] }),
        ],
      }),
    );
    assertValue(input.paymentFees, "verified", "3.1");
  });

  it("42. AUTHORIZATION fees are ignored", () => {
    const input = normalize(
      referenceSource({
        transactions: [transaction(), transaction({ id: "auth", kind: "AUTHORIZATION", fees: [eur("9")] })],
      }),
    );
    assertValue(input.paymentFees, "verified", "3");
  });

  for (const status of ["FAILURE", "PENDING"]) {
    it(`43/44. ${status} transaction is ignored`, () => {
      const input = normalize(
        referenceSource({
          transactions: [transaction(), transaction({ id: "other", status, fees: [eur("9")] })],
        }),
      );
      assertValue(input.paymentFees, "verified", "3");
    });
  }

  it("45. test transaction is ignored", () => {
    const input = normalize(
      referenceSource({ transactions: [transaction(), transaction({ id: "t", test: true, fees: [eur("9")] })] }),
    );
    assertValue(input.paymentFees, "verified", "3");
  });

  it("46. no proof of complete fees: missing, never verified 0", () => {
    const cases: SourceTransaction[][] = [
      [transaction({ fees: [] })],
      [transaction({ gateway: "paypal", fees: [] })],
      [transaction(), transaction({ id: "manual", gateway: "manual", fees: [] })],
      [],
    ];
    for (const transactions of cases) {
      assertValue(normalize(referenceSource({ transactions })).paymentFees, "missing", null);
    }
  });

  it("47. estimated override passed through", () => {
    const input = normalize(referenceSource({ transactions: [transaction({ gateway: "paypal", fees: [] })] }), {
      paymentFeesOverride: estimated("4.2"),
    });
    assertValue(input.paymentFees, "estimated", "4.2");
  });

  it("48. verified override passed through", () => {
    const input = normalize(referenceSource(), { paymentFeesOverride: verified("7") });
    assertValue(input.paymentFees, "verified", "7");
  });

  it("49. missing override passed through", () => {
    const input = normalize(referenceSource(), { paymentFeesOverride: missing });
    assertValue(input.paymentFees, "missing", null);
  });

  it("fees on a REFUND SUCCESS are unresolved", () => {
    assertNormalizationError(
      () =>
        normalize(
          referenceSource({
            refunds: [refund()],
            transactions: [transaction(), refundTransaction({ fees: [eur("0.5")] })],
          }),
        ),
      "UNRESOLVED_REFUND_FEES",
    );
  });
});

describe("external costs", () => {
  it("50/51/52. absent costs are missing", () => {
    const input = normalizeOrderProfitInput(referenceSource());
    assertValue(input.shippingCost, "missing", null);
    assertValue(input.adCost, "missing", null);
    assertValue(input.otherCosts, "missing", null);
  });

  it("53. shippingCost verified 0 is not missing", () => {
    const input = normalize(referenceSource(), { shippingCost: verified("0") });
    assertValue(input.shippingCost, "verified", "0");
  });

  it("54. estimated adCost propagated", () => {
    const input = normalize(referenceSource(), { adCost: estimated("12.34") });
    assertValue(input.adCost, "estimated", "12.34");
  });

  it("55. negative or malformed external values are rejected", () => {
    assertNormalizationError(() => normalize(referenceSource(), { otherCosts: verified("-1") }), "NEGATIVE_AMOUNT");
    assertNormalizationError(
      () => normalize(referenceSource(), { adCost: { status: "missing", amount: d("0") } as unknown as FinancialValue }),
      "INVALID_FINANCIAL_VALUE",
    );
    assertNormalizationError(
      () => normalize(referenceSource(), { adCost: { status: "verified", amount: null } as unknown as FinancialValue }),
      "INVALID_FINANCIAL_VALUE",
    );
    assertNormalizationError(
      () => normalize(referenceSource(), { adCost: { status: "verified", amount: 5 } as unknown as FinancialValue }),
      "INVALID_DECIMAL",
    );
    assertNormalizationError(
      () => normalize(referenceSource(), { adCost: { status: "verified", amount: d("NaN") } }),
      "INVALID_DECIMAL",
    );
  });
});

describe("currency", () => {
  it("56. order currency is used", () => {
    const usd = (amount: string) => eur(amount, "USD");
    const input = normalize(
      {
        order: { currencyCode: "USD", taxesIncluded: false, test: false },
        orderLines: [line({ currencyCode: "USD", costSnapshot: snapshot({ currencyCode: "USD" }) })],
        shippingLines: [shipping({ currencyCode: "USD" })],
        transactions: [transaction({ currencyCode: "USD", fees: [usd("3")] })],
        refunds: [],
      },
      {},
    );
    assert.equal(input.currency, "USD");
  });

  it("empty order currency is rejected", () => {
    assertNormalizationError(() => normalize(withOrder({ currencyCode: " " })), "INVALID_CURRENCY");
  });

  const mismatches: [string, () => OrderProfitNormalizationSource][] = [
    ["57. OrderLine", () => referenceSource({ orderLines: [line({ currencyCode: "USD" })] })],
    ["discount allocation", () => referenceSource({ orderLines: [line({ discountAllocations: [eur("1", "USD")] })] })],
    ["58. ShippingLine", () => referenceSource({ shippingLines: [shipping({ currencyCode: "USD" })] })],
    ["59. Refund", () => referenceSource({ refunds: [refund({ currencyCode: "USD" })] })],
    ["RefundLine", () => referenceSource({ refunds: [refund({ lines: [refundLine({ currencyCode: "USD" })] })] })],
    ["60. Transaction", () => referenceSource({ transactions: [transaction({ currencyCode: "USD" })] })],
    ["TransactionFee", () => referenceSource({ transactions: [transaction({ fees: [eur("3", "USD")] })] })],
    ["61. CostSnapshot", () => referenceSource({ orderLines: [line({ costSnapshot: snapshot({ currencyCode: "USD" }) })] })],
  ];
  for (const [name, build] of mismatches) {
    it(`${name} in another currency is rejected`, () => {
      assertNormalizationError(() => normalize(build()), "CURRENCY_MISMATCH");
    });
  }
});

describe("purity", () => {
  const busySource = () =>
    referenceSource({
      orderLines: [line({ quantity: 3, discountAllocations: [eur("10")] }), line({ id: "line-2", costSnapshot: snapshot({ source: "ESTIMATED" }) })],
      refunds: [refund()],
      transactions: [transaction(), refundTransaction()],
    });

  it("62. two identical calls give identical results", () => {
    const first = normalize(busySource());
    const second = normalize(busySource());
    assert.deepStrictEqual(first, second);
  });

  it("63/64. source and external costs are not mutated", () => {
    const source = busySource();
    const external: ExternalProfitCosts = { ...referenceExternal, paymentFeesOverride: estimated("1") };
    const before = JSON.stringify([source, external]);
    deepFreeze(source);
    deepFreeze(external);
    normalize(source, external);
    assert.equal(JSON.stringify([source, external]), before);
  });

  it("65. no NaN or Infinity in any output amount", () => {
    const input = normalize(busySource());
    for (const value of amountsOf(input)) assert.ok(value.isFinite());
  });

  it("66. JS numbers are rejected as amounts", () => {
    assertNormalizationError(
      () => normalize(referenceSource({ orderLines: [line({ originalTotal: 100 as unknown as Decimal })] })),
      "INVALID_DECIMAL",
    );
    for (const value of amountsOf(normalize(busySource()))) assert.ok(Decimal.isDecimal(value));
  });
});

function amountsOf(input: OrderProfitInput): Decimal[] {
  const values = [input.productRevenueExTax, input.shippingRevenueExTax, input.economicRefundsExTax];
  for (const cost of [input.cogs, input.shippingCost, input.paymentFees, input.adCost, input.otherCosts]) {
    if (cost.amount !== null) values.push(cost.amount);
  }
  return values;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Decimal.isDecimal(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}
