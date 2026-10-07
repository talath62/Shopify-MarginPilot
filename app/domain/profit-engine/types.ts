import type { Decimal } from "./money.ts";

/**
 * A cost and its provenance (PG-000 D7).
 * A verified 0 is a known cost of zero. "missing" is an unknown cost and is never 0.
 */
export type FinancialValue =
  | { status: "verified"; amount: Decimal }
  | { status: "estimated"; amount: Decimal }
  | { status: "missing"; amount: null };

export type FinancialValueStatus = FinancialValue["status"];

/**
 * Normalized order data. All amounts are in `currency`, excluding taxes.
 * The engine knows no Shopify concept: a future normalizer builds this object.
 */
export interface OrderProfitInput {
  /** Currency of every amount below. No FX conversion is done. */
  currency: string;
  /** Product revenue excluding tax, after discounts (PG-000 D1). Gift cards excluded. */
  productRevenueExTax: Decimal;
  /** Shipping billed to the customer, excluding tax. Not the merchant's shipping cost. */
  shippingRevenueExTax: Decimal;
  /** Successful economic refunds excluding tax, store credit included (D6). Never PENDING. */
  economicRefundsExTax: Decimal;
  /** Net COGS after returns (D3 applied by the normalizer). */
  cogs: FinancialValue;
  /** Real shipping cost paid by the merchant. */
  shippingCost: FinancialValue;
  paymentFees: FinancialValue;
  /** Acquisition cost attributed to this order. */
  adCost: FinancialValue;
  /** Normalized total of other order-level costs. */
  otherCosts: FinancialValue;
}

export interface ProfitEngineConfig {
  /** Margin percent under which a profitable order is LOW_MARGIN. Range [0, 100]. */
  lowMarginThresholdPercent: Decimal;
}

/** Overall data quality of the calculation. "estimated" is not "incomplete". */
export type CalculationCompleteness = "complete" | "estimated" | "incomplete";

/** Quality of one computed metric. */
export type MetricQuality = "verified" | "estimated" | "unavailable";

export type ProfitabilityState =
  | "PROFITABLE"
  | "LOW_MARGIN"
  | "LOSS"
  | "INCOMPLETE";

export interface OrderProfitMetricQuality {
  grossCommercialRevenue: MetricQuality;
  netRevenue: MetricQuality;
  operatingCostsBeforeAds: MetricQuality;
  profitBeforeAds: MetricQuality;
  maxProfitableCpa: MetricQuality;
  breakEvenRoas: MetricQuality;
  profit: MetricQuality;
  marginPercent: MetricQuality;
}

/**
 * Engine output. Every amount and ratio is a Decimal, never rounded or formatted.
 * A null metric is "unavailable": see `quality`.
 */
export interface OrderProfitResult {
  calculationVersion: number;
  currency: string;

  // Inputs, as used by the calculation.
  productRevenueExTax: Decimal;
  shippingRevenueExTax: Decimal;
  economicRefundsExTax: Decimal;
  cogs: FinancialValue;
  shippingCost: FinancialValue;
  paymentFees: FinancialValue;
  adCost: FinancialValue;
  otherCosts: FinancialValue;

  // Computed metrics.
  grossCommercialRevenue: Decimal;
  netRevenue: Decimal;
  operatingCostsBeforeAds: Decimal | null;
  profitBeforeAds: Decimal | null;
  maxProfitableCpa: Decimal | null;
  breakEvenRoas: Decimal | null;
  profit: Decimal | null;
  marginPercent: Decimal | null;

  quality: OrderProfitMetricQuality;
  completeness: CalculationCompleteness;
  profitabilityState: ProfitabilityState;
}

export type ProfitEngineErrorCode =
  | "INVALID_CURRENCY"
  | "INVALID_DECIMAL"
  | "NEGATIVE_AMOUNT"
  | "INVALID_FINANCIAL_VALUE"
  | "INVALID_CONFIG";

/** Raised for any impossible input. The engine never corrects data silently. */
export class ProfitEngineInputError extends Error {
  readonly code: ProfitEngineErrorCode;
  readonly field: string;

  constructor(code: ProfitEngineErrorCode, field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ProfitEngineInputError";
    this.code = code;
    this.field = field;
  }
}
