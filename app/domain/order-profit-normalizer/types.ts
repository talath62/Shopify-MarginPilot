import type { Decimal } from "../profit-engine/money.ts";
import type { FinancialValue } from "../profit-engine/index.ts";

/**
 * In-memory snapshot of ONE order, built from PG-001 data by a future loader.
 *
 * Complete aggregate contract: the caller guarantees that every collection is
 * complete (all order lines, shipping lines, transactions with all their fees,
 * refunds with all their lines, shipping lines and adjustments). An empty
 * collection means "none exists", never "not loaded". Partial loading is forbidden.
 *
 * All amounts are shopMoney Decimals as persisted by PG-001.
 */
export interface OrderProfitNormalizationSource {
  order: {
    currencyCode: string;
    taxesIncluded: boolean;
    test: boolean;
  };
  orderLines: readonly SourceOrderLine[];
  shippingLines: readonly SourceShippingLine[];
  transactions: readonly SourceTransaction[];
  refunds: readonly SourceRefund[];
}

/** Mirrors the PG-001 CostSource enum. */
export type SourceCostSource =
  | "SHOPIFY_UNIT_COST"
  | "MANUAL"
  | "ESTIMATED"
  | "MISSING";

export interface SourceAmount {
  amount: Decimal;
  currencyCode: string;
}

export interface SourceOrderLine {
  id: string;
  /** Ordered quantity, including refunded and removed units. */
  quantity: number;
  isGiftCard: boolean;
  originalTotal: Decimal;
  currencyCode: string;
  discountAllocations: readonly SourceAmount[];
  taxLines: readonly SourceAmount[];
  /** OrderLineCostSnapshot. null when no snapshot exists. */
  costSnapshot: SourceCostSnapshot | null;
}

export interface SourceCostSnapshot {
  /** null if and only if source is MISSING (PG-001 CHECK constraint). */
  unitCost: Decimal | null;
  currencyCode: string | null;
  source: SourceCostSource;
  historicalApproximation: boolean;
}

export interface SourceShippingLine {
  isRemoved: boolean;
  /** Price billed to the customer, already net of shipping discounts. */
  discountedPrice: Decimal;
  currencyCode: string;
  taxLines: readonly SourceAmount[];
}

export interface SourceTransaction {
  id: string;
  /** Refund this transaction belongs to (Refund.transactions), or null. */
  refundId: string | null;
  /** Shopify OrderTransactionKind (SALE, CAPTURE, REFUND...). */
  kind: string;
  /** Shopify OrderTransactionStatus (SUCCESS, PENDING...). */
  status: string;
  gateway: string | null;
  amount: Decimal;
  currencyCode: string;
  test: boolean;
  /** Verified Shopify Payments fees (TransactionFee rows). */
  fees: readonly SourceAmount[];
}

export interface SourceRefund {
  id: string;
  /** Shopify control total. Never used as a source amount. */
  totalRefunded: Decimal;
  currencyCode: string;
  lines: readonly SourceRefundLine[];
  shippingLines: readonly SourceRefundShippingLine[];
  adjustments: readonly SourceRefundAdjustment[];
}

export interface SourceRefundLine {
  orderLineId: string;
  quantity: number;
  subtotal: Decimal;
  taxAmount: Decimal;
  currencyCode: string;
  /** Shopify restock type (RETURN, CANCEL, NO_RESTOCK). */
  restockType: string;
}

export interface SourceRefundShippingLine {
  subtotalAmount: Decimal;
  taxAmount: Decimal;
  currencyCode: string;
}

export interface SourceRefundAdjustment {
  reason: string;
  amount: Decimal;
  taxAmount: Decimal;
  currencyCode: string;
}

/**
 * Costs that PG-001 does not persist yet. Each value is passed through unchanged
 * after validation. An absent value becomes missing, never 0.
 */
export interface ExternalProfitCosts {
  shippingCost?: FinancialValue;
  adCost?: FinancialValue;
  otherCosts?: FinancialValue;
  /** Replaces the fees derived from TransactionFee rows. */
  paymentFeesOverride?: FinancialValue;
}

export type OrderProfitNormalizationErrorCode =
  | "INVALID_CURRENCY"
  | "CURRENCY_MISMATCH"
  | "INVALID_DECIMAL"
  | "NEGATIVE_AMOUNT"
  | "INVALID_DISCOUNT"
  | "INVALID_QUANTITY"
  | "INVALID_RETURN_QUANTITY"
  | "UNKNOWN_RESTOCK_TYPE"
  | "INCONSISTENT_AGGREGATE"
  | "TEST_ORDER_NOT_NORMALIZABLE"
  | "UNRESOLVED_TAX_INCLUDED_REFUND"
  | "UNRESOLVED_REFUND_ADJUSTMENT"
  | "UNRESOLVED_GIFT_CARD_REFUND"
  | "UNRESOLVED_REFUND_FEES"
  | "AMBIGUOUS_PARTIAL_REFUND"
  | "REFUND_TOTAL_MISMATCH"
  | "INVALID_FINANCIAL_VALUE";

/** Raised when the source cannot be normalized without guessing. */
export class OrderProfitNormalizationError extends Error {
  readonly code: OrderProfitNormalizationErrorCode;
  readonly field: string;

  constructor(code: OrderProfitNormalizationErrorCode, field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "OrderProfitNormalizationError";
    this.code = code;
    this.field = field;
  }
}
