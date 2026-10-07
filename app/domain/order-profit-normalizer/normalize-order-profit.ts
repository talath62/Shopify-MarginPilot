import {
  Decimal,
  EngineDecimal,
  ZERO,
  sum,
  toEngineDecimal,
} from "../profit-engine/money.ts";
import type { FinancialValue, OrderProfitInput } from "../profit-engine/index.ts";
import { OrderProfitNormalizationError } from "./types.ts";
import type {
  ExternalProfitCosts,
  OrderProfitNormalizationSource,
  SourceAmount,
  SourceCostSnapshot,
  SourceOrderLine,
  SourceRefund,
  SourceTransaction,
} from "./types.ts";

/** A fresh object each time: results never share mutable state. */
function missing(): FinancialValue {
  return { status: "missing", amount: null };
}

/** Restock types whose returned quantity gives its COGS back (PG-000 D3). */
const COGS_RETURNED_RESTOCK_TYPES = new Set(["RETURN", "CANCEL"]);
const COGS_KEPT_RESTOCK_TYPES = new Set(["NO_RESTOCK"]);

/** Refund transaction statuses that can never become money later. */
const FINAL_FAILED_STATUSES = new Set(["FAILURE", "ERROR"]);

const SHOPIFY_PAYMENTS_GATEWAY = "shopify_payments";

/**
 * Builds the PG-002 OrderProfitInput of one order from its PG-001 aggregate
 * (see docs/PG-003-order-profit-normalizer.md).
 * Pure: no I/O, no clock, no mutation. Throws OrderProfitNormalizationError
 * instead of guessing.
 */
export function normalizeOrderProfitInput(
  source: OrderProfitNormalizationSource,
  externalCosts: ExternalProfitCosts = {},
): OrderProfitInput {
  if (source.order.test) {
    throw new OrderProfitNormalizationError(
      "TEST_ORDER_NOT_NORMALIZABLE",
      "order.test",
      "test orders are excluded from profit calculations",
    );
  }
  const currency = validateCurrency(source.order.currencyCode);
  const ctx = { currency, taxesIncluded: source.order.taxesIncluded };

  const linesById = new Map<string, SourceOrderLine>();
  for (const line of source.orderLines) linesById.set(line.id, line);

  return {
    currency,
    productRevenueExTax: productRevenueExTax(source.orderLines, ctx),
    shippingRevenueExTax: shippingRevenueExTax(source, ctx),
    economicRefundsExTax: economicRefundsExTax(source, linesById, ctx),
    cogs: netCogs(source, linesById, ctx),
    shippingCost: externalValue(externalCosts.shippingCost, "externalCosts.shippingCost"),
    paymentFees:
      externalCosts.paymentFeesOverride === undefined
        ? paymentFees(source.transactions, ctx)
        : externalValue(
            externalCosts.paymentFeesOverride,
            "externalCosts.paymentFeesOverride",
          ),
    adCost: externalValue(externalCosts.adCost, "externalCosts.adCost"),
    otherCosts: externalValue(externalCosts.otherCosts, "externalCosts.otherCosts"),
  };
}

interface Context {
  currency: string;
  taxesIncluded: boolean;
}

// ---------------------------------------------------------------------------
// Revenue (PG-000 D1, §3.2)
// ---------------------------------------------------------------------------

function productRevenueExTax(
  lines: readonly SourceOrderLine[],
  ctx: Context,
): Decimal {
  const revenues: Decimal[] = [];
  lines.forEach((line, index) => {
    const field = `orderLines[${index}]`;
    checkCurrency(line.currencyCode, ctx, `${field}.currencyCode`);
    const originalTotal = amountOf(line.originalTotal, `${field}.originalTotal`);
    const discounts = sumAmounts(line.discountAllocations, ctx, `${field}.discountAllocations`);
    const taxes = sumAmounts(line.taxLines, ctx, `${field}.taxLines`);
    if (line.isGiftCard) return;

    const afterDiscount = originalTotal.minus(discounts);
    if (afterDiscount.lt(ZERO)) {
      throw new OrderProfitNormalizationError(
        "INVALID_DISCOUNT",
        field,
        `discounts ${discounts.toString()} exceed originalTotal ${originalTotal.toString()}`,
      );
    }
    const revenue = ctx.taxesIncluded ? afterDiscount.minus(taxes) : afterDiscount;
    if (revenue.lt(ZERO)) {
      throw new OrderProfitNormalizationError(
        "NEGATIVE_AMOUNT",
        field,
        `taxes ${taxes.toString()} exceed the tax-included line price ${afterDiscount.toString()}`,
      );
    }
    revenues.push(revenue);
  });
  return sum(revenues);
}

function shippingRevenueExTax(
  source: OrderProfitNormalizationSource,
  ctx: Context,
): Decimal {
  const revenues: Decimal[] = [];
  source.shippingLines.forEach((line, index) => {
    const field = `shippingLines[${index}]`;
    checkCurrency(line.currencyCode, ctx, `${field}.currencyCode`);
    const price = amountOf(line.discountedPrice, `${field}.discountedPrice`);
    const taxes = sumAmounts(line.taxLines, ctx, `${field}.taxLines`);
    if (line.isRemoved) return;

    const revenue = ctx.taxesIncluded ? price.minus(taxes) : price;
    if (revenue.lt(ZERO)) {
      throw new OrderProfitNormalizationError(
        "NEGATIVE_AMOUNT",
        field,
        `taxes ${taxes.toString()} exceed the tax-included shipping price ${price.toString()}`,
      );
    }
    revenues.push(revenue);
  });
  return sum(revenues);
}

// ---------------------------------------------------------------------------
// Economic refunds (PG-000 §5, D6): money from SUCCESS transactions,
// amount excluding tax from the Refund lines.
// ---------------------------------------------------------------------------

function economicRefundsExTax(
  source: OrderProfitNormalizationSource,
  linesById: ReadonlyMap<string, SourceOrderLine>,
  ctx: Context,
): Decimal {
  const refundIds = new Set(source.refunds.map((refund) => refund.id));
  const refundTransactions = new Map<string, SourceTransaction[]>();

  source.transactions.forEach((transaction, index) => {
    const field = `transactions[${index}]`;
    checkCurrency(transaction.currencyCode, ctx, `${field}.currencyCode`);
    amountOf(transaction.amount, `${field}.amount`);
    if (transaction.kind !== "REFUND" || transaction.test) return;

    if (transaction.refundId === null || !refundIds.has(transaction.refundId)) {
      throw new OrderProfitNormalizationError(
        "INCONSISTENT_AGGREGATE",
        field,
        "REFUND transaction is not linked to a refund of this order",
      );
    }
    const list = refundTransactions.get(transaction.refundId) ?? [];
    list.push(transaction);
    refundTransactions.set(transaction.refundId, list);
  });

  const refunds = source.refunds.map((refund, index) =>
    realizedRefundExTax(
      refund,
      refundTransactions.get(refund.id) ?? [],
      linesById,
      ctx,
      `refunds[${index}]`,
    ),
  );
  return sum(refunds);
}

/** Excluding-tax amount of one refund, or 0 when no money moved. */
function realizedRefundExTax(
  refund: SourceRefund,
  transactions: readonly SourceTransaction[],
  linesById: ReadonlyMap<string, SourceOrderLine>,
  ctx: Context,
  field: string,
): Decimal {
  checkCurrency(refund.currencyCode, ctx, `${field}.currencyCode`);
  const totalRefunded = amountOf(refund.totalRefunded, `${field}.totalRefunded`);

  const lineSubtotals: Decimal[] = [];
  const lineTaxes: Decimal[] = [];
  let containsGiftCard = false;
  refund.lines.forEach((line, index) => {
    const lineField = `${field}.lines[${index}]`;
    checkCurrency(line.currencyCode, ctx, `${lineField}.currencyCode`);
    lineSubtotals.push(amountOf(line.subtotal, `${lineField}.subtotal`));
    lineTaxes.push(amountOf(line.taxAmount, `${lineField}.taxAmount`));
    if (linesById.get(line.orderLineId)?.isGiftCard) containsGiftCard = true;
  });
  const shippingSubtotals: Decimal[] = [];
  const shippingTaxes: Decimal[] = [];
  refund.shippingLines.forEach((line, index) => {
    const lineField = `${field}.shippingLines[${index}]`;
    checkCurrency(line.currencyCode, ctx, `${lineField}.currencyCode`);
    shippingSubtotals.push(amountOf(line.subtotalAmount, `${lineField}.subtotalAmount`));
    shippingTaxes.push(amountOf(line.taxAmount, `${lineField}.taxAmount`));
  });
  const adjustments = refund.adjustments.map((adjustment, index) => {
    const adjustmentField = `${field}.adjustments[${index}]`;
    checkCurrency(adjustment.currencyCode, ctx, `${adjustmentField}.currencyCode`);
    return {
      amount: decimalOf(adjustment.amount, `${adjustmentField}.amount`),
      taxAmount: decimalOf(adjustment.taxAmount, `${adjustmentField}.taxAmount`),
    };
  });

  const successful = transactions.filter((transaction) => transaction.status === "SUCCESS");
  // A Refund without a successful transaction moved no money (PG-000 §5).
  if (successful.length === 0) return ZERO;

  if (ctx.taxesIncluded) {
    throw new OrderProfitNormalizationError(
      "UNRESOLVED_TAX_INCLUDED_REFUND",
      field,
      "meaning of RefundLineItem.subtotalSet with taxesIncluded=true is [NC] in PG-000 §3.2",
    );
  }
  if (adjustments.some((adjustment) => !adjustment.amount.isZero() || !adjustment.taxAmount.isZero())) {
    throw new OrderProfitNormalizationError(
      "UNRESOLVED_REFUND_ADJUSTMENT",
      `${field}.adjustments`,
      "orderAdjustments treatment is [NC] in PG-000 §3.2",
    );
  }
  if (containsGiftCard) {
    throw new OrderProfitNormalizationError(
      "UNRESOLVED_GIFT_CARD_REFUND",
      `${field}.lines`,
      "refund of a gift card line has no rule in PG-000 (gift cards are excluded from revenue)",
    );
  }
  const unsettled = transactions.filter(
    (transaction) =>
      transaction.status !== "SUCCESS" && !FINAL_FAILED_STATUSES.has(transaction.status),
  );
  if (unsettled.length > 0) {
    throw new OrderProfitNormalizationError(
      "AMBIGUOUS_PARTIAL_REFUND",
      field,
      "refund has SUCCESS and unsettled REFUND transactions: the realized part is unknown",
    );
  }

  // Consistency control: the money moved must match the refund reconstruction.
  const moved = sum(successful.map((transaction) => toEngineDecimal(transaction.amount)));
  const reconstructed = sum([
    ...lineSubtotals,
    ...lineTaxes,
    ...shippingSubtotals,
    ...shippingTaxes,
  ]);
  if (!moved.eq(reconstructed)) {
    throw new OrderProfitNormalizationError(
      "AMBIGUOUS_PARTIAL_REFUND",
      field,
      `successful transactions total ${moved.toString()} but refund lines total ${reconstructed.toString()}`,
    );
  }
  if (!totalRefunded.eq(moved)) {
    throw new OrderProfitNormalizationError(
      "REFUND_TOTAL_MISMATCH",
      `${field}.totalRefunded`,
      `control total ${totalRefunded.toString()} differs from successful transactions ${moved.toString()}`,
    );
  }

  // taxesIncluded=false: subtotals exclude tax (PG-000 §3.2).
  return sum([...lineSubtotals, ...shippingSubtotals]);
}

// ---------------------------------------------------------------------------
// COGS (PG-000 §4.2, D3): snapshot cost only, returns by restock type.
// ---------------------------------------------------------------------------

function netCogs(
  source: OrderProfitNormalizationSource,
  linesById: ReadonlyMap<string, SourceOrderLine>,
  ctx: Context,
): FinancialValue {
  const returnedQuantity = new Map<string, number>();
  source.refunds.forEach((refund, refundIndex) => {
    refund.lines.forEach((line, index) => {
      const field = `refunds[${refundIndex}].lines[${index}]`;
      const quantity = quantityOf(line.quantity, `${field}.quantity`);
      if (!linesById.has(line.orderLineId)) {
        throw new OrderProfitNormalizationError(
          "INCONSISTENT_AGGREGATE",
          `${field}.orderLineId`,
          "refund line references an unknown order line",
        );
      }
      if (COGS_RETURNED_RESTOCK_TYPES.has(line.restockType)) {
        returnedQuantity.set(
          line.orderLineId,
          (returnedQuantity.get(line.orderLineId) ?? 0) + quantity,
        );
      } else if (!COGS_KEPT_RESTOCK_TYPES.has(line.restockType)) {
        throw new OrderProfitNormalizationError(
          "UNKNOWN_RESTOCK_TYPE",
          `${field}.restockType`,
          `restock type "${line.restockType}" has no COGS rule in PG-000 D3`,
        );
      }
    });
  });

  let anyMissing = false;
  let anyEstimated = false;
  const lineCogs: Decimal[] = [];

  source.orderLines.forEach((line, index) => {
    const field = `orderLines[${index}]`;
    const quantity = quantityOf(line.quantity, `${field}.quantity`);
    const returned = returnedQuantity.get(line.id) ?? 0;
    if (returned > quantity) {
      throw new OrderProfitNormalizationError(
        "INVALID_RETURN_QUANTITY",
        field,
        `returned quantity ${returned} exceeds ordered quantity ${quantity}`,
      );
    }
    const unitCost = snapshotCost(line.costSnapshot, ctx, `${field}.costSnapshot`);
    if (line.isGiftCard) return;

    if (unitCost.status === "missing") {
      anyMissing = true;
      return;
    }
    if (unitCost.status === "estimated") anyEstimated = true;
    const gross = unitCost.amount.times(new EngineDecimal(quantity));
    const reintegrated = unitCost.amount.times(new EngineDecimal(returned));
    lineCogs.push(gross.minus(reintegrated));
  });

  if (anyMissing) return missing();
  return { status: anyEstimated ? "estimated" : "verified", amount: sum(lineCogs) };
}

/** Snapshot provenance mapping. historicalApproximation only downgrades SHOPIFY_UNIT_COST. */
function snapshotCost(
  snapshot: SourceCostSnapshot | null,
  ctx: Context,
  field: string,
): FinancialValue {
  if (snapshot === null) return missing();
  if (snapshot.source === "MISSING") {
    if (snapshot.unitCost !== null) {
      throw new OrderProfitNormalizationError(
        "INVALID_FINANCIAL_VALUE",
        `${field}.unitCost`,
        "a MISSING snapshot must have unitCost null",
      );
    }
    return missing();
  }
  if (snapshot.unitCost === null) {
    throw new OrderProfitNormalizationError(
      "INVALID_FINANCIAL_VALUE",
      `${field}.unitCost`,
      `a ${snapshot.source} snapshot must have a unitCost`,
    );
  }
  checkCurrency(snapshot.currencyCode, ctx, `${field}.currencyCode`);
  const amount = amountOf(snapshot.unitCost, `${field}.unitCost`);

  switch (snapshot.source) {
    case "SHOPIFY_UNIT_COST":
      // Historical backfill: current cost applied to a past order.
      return snapshot.historicalApproximation
        ? { status: "estimated", amount }
        : { status: "verified", amount };
    case "MANUAL":
      // Explicitly entered by the merchant: verified, whatever the backfill flag.
      return { status: "verified", amount };
    case "ESTIMATED":
      return { status: "estimated", amount };
    default:
      throw new OrderProfitNormalizationError(
        "INVALID_FINANCIAL_VALUE",
        `${field}.source`,
        `unknown cost source "${String(snapshot.source)}"`,
      );
  }
}

// ---------------------------------------------------------------------------
// Payment fees (PG-000 §8): verified only when provably complete.
// ---------------------------------------------------------------------------

function paymentFees(
  transactions: readonly SourceTransaction[],
  ctx: Context,
): FinancialValue {
  const fees: Decimal[] = [];
  let provablyComplete = true;
  let paymentCount = 0;

  transactions.forEach((transaction, index) => {
    const field = `transactions[${index}]`;
    const transactionFees = transaction.fees.map((fee, feeIndex) =>
      feeAmount(fee, ctx, `${field}.fees[${feeIndex}]`),
    );
    if (transaction.test || transaction.status !== "SUCCESS") return;

    if (transaction.kind === "REFUND" && transactionFees.length > 0) {
      throw new OrderProfitNormalizationError(
        "UNRESOLVED_REFUND_FEES",
        `${field}.fees`,
        "fees on a refund transaction have no documented meaning or sign ([NC] PG-000 §8)",
      );
    }
    if (transaction.kind !== "SALE" && transaction.kind !== "CAPTURE") return;

    paymentCount += 1;
    // Only Shopify Payments exposes fees, filled at once ([T] PG-000 §8).
    // Any other gateway, or an empty fee list, does not prove the fees.
    if (transaction.gateway !== SHOPIFY_PAYMENTS_GATEWAY || transactionFees.length === 0) {
      provablyComplete = false;
    }
    fees.push(...transactionFees);
  });

  if (paymentCount === 0 || !provablyComplete) return missing();
  return { status: "verified", amount: sum(fees) };
}

function feeAmount(fee: SourceAmount, ctx: Context, field: string): Decimal {
  checkCurrency(fee.currencyCode, ctx, `${field}.currencyCode`);
  return amountOf(fee.amount, `${field}.amount`);
}

// ---------------------------------------------------------------------------
// External costs: passed through after validation, absent means missing.
// ---------------------------------------------------------------------------

function externalValue(value: FinancialValue | undefined, field: string): FinancialValue {
  if (value === undefined) return missing();
  if (typeof value !== "object" || value === null) {
    throw new OrderProfitNormalizationError(
      "INVALID_FINANCIAL_VALUE",
      field,
      "must be a FinancialValue",
    );
  }
  // Runtime data may not respect the static type: read it as unknown.
  const { status, amount } = value as { status: unknown; amount: unknown };
  if (status === "missing") {
    if (amount !== null) {
      throw new OrderProfitNormalizationError(
        "INVALID_FINANCIAL_VALUE",
        field,
        "a missing value must have amount null",
      );
    }
    return missing();
  }
  if (status === "verified" || status === "estimated") {
    if (amount === null || amount === undefined) {
      throw new OrderProfitNormalizationError(
        "INVALID_FINANCIAL_VALUE",
        field,
        `a ${status} value must have an amount`,
      );
    }
    return { status, amount: amountOf(amount, `${field}.amount`) };
  }
  throw new OrderProfitNormalizationError(
    "INVALID_FINANCIAL_VALUE",
    field,
    "status must be verified, estimated or missing",
  );
}

// ---------------------------------------------------------------------------
// Validation helpers. Nothing is corrected: invalid data throws.
// ---------------------------------------------------------------------------

function validateCurrency(currency: unknown): string {
  if (typeof currency !== "string" || currency.trim() === "") {
    throw new OrderProfitNormalizationError(
      "INVALID_CURRENCY",
      "order.currencyCode",
      "must be a non-empty currency code",
    );
  }
  return currency;
}

/** Order.currencyCode is the only reference. Shop currency is never used. */
function checkCurrency(currency: unknown, ctx: Context, field: string): void {
  if (currency !== ctx.currency) {
    throw new OrderProfitNormalizationError(
      "CURRENCY_MISMATCH",
      field,
      `expected ${ctx.currency}, got ${String(currency)}`,
    );
  }
}

function decimalOf(value: unknown, field: string): Decimal {
  if (!Decimal.isDecimal(value) || !value.isFinite()) {
    throw new OrderProfitNormalizationError(
      "INVALID_DECIMAL",
      field,
      "must be a finite Decimal",
    );
  }
  return toEngineDecimal(value);
}

function amountOf(value: unknown, field: string): Decimal {
  const amount = decimalOf(value, field);
  if (amount.lt(ZERO)) {
    throw new OrderProfitNormalizationError(
      "NEGATIVE_AMOUNT",
      field,
      `must not be negative (got ${amount.toString()})`,
    );
  }
  return amount;
}

function sumAmounts(amounts: readonly SourceAmount[], ctx: Context, field: string): Decimal {
  return sum(
    amounts.map((item, index) => {
      checkCurrency(item.currencyCode, ctx, `${field}[${index}].currencyCode`);
      return amountOf(item.amount, `${field}[${index}].amount`);
    }),
  );
}

/** Quantities are unit counts, not money: safe non-negative integers. */
function quantityOf(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderProfitNormalizationError(
      "INVALID_QUANTITY",
      field,
      "must be a non-negative integer",
    );
  }
  return value;
}
