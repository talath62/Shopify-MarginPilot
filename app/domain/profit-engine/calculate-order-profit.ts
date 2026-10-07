import {
  Decimal,
  ONE_HUNDRED,
  ZERO,
  sum,
  toEngineDecimal,
} from "./money.ts";
import { ProfitEngineInputError } from "./types.ts";
import type {
  CalculationCompleteness,
  FinancialValue,
  MetricQuality,
  OrderProfitInput,
  OrderProfitResult,
  ProfitEngineConfig,
  ProfitabilityState,
} from "./types.ts";

/** Version of the calculation rules. Bump it whenever a formula or rule changes. */
export const PROFIT_ENGINE_VERSION = 1;

/**
 * Computes the profit of one order from normalized inputs (see docs/PG-002-profit-engine.md).
 * Pure and deterministic: no I/O, no clock, no randomness, no input mutation.
 * Throws ProfitEngineInputError on impossible input.
 */
export function calculateOrderProfit(
  input: OrderProfitInput,
  config: ProfitEngineConfig,
): OrderProfitResult {
  const lowMarginThresholdPercent = validateThreshold(
    config.lowMarginThresholdPercent,
  );
  const currency = validateCurrency(input.currency);

  const productRevenueExTax = validateAmount(
    input.productRevenueExTax,
    "productRevenueExTax",
  );
  const shippingRevenueExTax = validateAmount(
    input.shippingRevenueExTax,
    "shippingRevenueExTax",
  );
  const economicRefundsExTax = validateAmount(
    input.economicRefundsExTax,
    "economicRefundsExTax",
  );
  const cogs = validateFinancialValue(input.cogs, "cogs");
  const shippingCost = validateFinancialValue(input.shippingCost, "shippingCost");
  const paymentFees = validateFinancialValue(input.paymentFees, "paymentFees");
  const adCost = validateFinancialValue(input.adCost, "adCost");
  const otherCosts = validateFinancialValue(input.otherCosts, "otherCosts");

  // Revenue: inputs are already excluding tax. Taxes, duties, tips and
  // additional fees are never part of it (PG-000 D1).
  const grossCommercialRevenue = productRevenueExTax.plus(shippingRevenueExTax);
  const netRevenue = grossCommercialRevenue.minus(economicRefundsExTax);

  const costsBeforeAds = [cogs, shippingCost, paymentFees, otherCosts];
  const allCosts = [...costsBeforeAds, adCost];

  const operatingQuality = combineQuality(costsBeforeAds);
  const operatingCostsBeforeAds = knownTotal(costsBeforeAds);
  const profitBeforeAds =
    operatingCostsBeforeAds === null
      ? null
      : netRevenue.minus(operatingCostsBeforeAds);

  const maxProfitableCpa =
    profitBeforeAds === null
      ? null
      : profitBeforeAds.gt(ZERO)
        ? profitBeforeAds
        : ZERO;

  // Only meaningful when some ad spend can still be absorbed.
  const breakEvenRoas =
    maxProfitableCpa !== null && maxProfitableCpa.gt(ZERO)
      ? netRevenue.div(maxProfitableCpa)
      : null;

  const profitQuality = combineQuality(allCosts);
  const profit =
    profitBeforeAds === null || adCost.amount === null
      ? null
      : profitBeforeAds.minus(adCost.amount);

  // profit * 100 / netRevenue: one division only, never by zero or a negative base.
  const marginPercent =
    profit !== null && netRevenue.gt(ZERO)
      ? profit.times(ONE_HUNDRED).div(netRevenue)
      : null;

  return {
    calculationVersion: PROFIT_ENGINE_VERSION,
    currency,
    productRevenueExTax,
    shippingRevenueExTax,
    economicRefundsExTax,
    cogs,
    shippingCost,
    paymentFees,
    adCost,
    otherCosts,
    grossCommercialRevenue,
    netRevenue,
    operatingCostsBeforeAds,
    profitBeforeAds,
    maxProfitableCpa,
    breakEvenRoas,
    profit,
    marginPercent,
    quality: {
      grossCommercialRevenue: "verified",
      netRevenue: "verified",
      operatingCostsBeforeAds: operatingQuality,
      profitBeforeAds: operatingQuality,
      maxProfitableCpa: operatingQuality,
      breakEvenRoas: breakEvenRoas === null ? "unavailable" : operatingQuality,
      profit: profitQuality,
      marginPercent: marginPercent === null ? "unavailable" : profitQuality,
    },
    completeness: toCompleteness(profitQuality),
    profitabilityState: classify(
      profit,
      marginPercent,
      lowMarginThresholdPercent,
    ),
  };
}

function classify(
  profit: Decimal | null,
  marginPercent: Decimal | null,
  lowMarginThresholdPercent: Decimal,
): ProfitabilityState {
  if (profit === null) return "INCOMPLETE";
  if (profit.lt(ZERO)) return "LOSS";
  // A zero profit is never PROFITABLE, whatever the threshold.
  if (profit.isZero()) return "LOW_MARGIN";
  if (marginPercent !== null && marginPercent.lt(lowMarginThresholdPercent)) {
    return "LOW_MARGIN";
  }
  return "PROFITABLE";
}

/** missing => unavailable; else any estimated => estimated; else verified. */
function combineQuality(values: readonly FinancialValue[]): MetricQuality {
  if (values.some((value) => value.status === "missing")) return "unavailable";
  if (values.some((value) => value.status === "estimated")) return "estimated";
  return "verified";
}

/** Sum of the amounts, or null as soon as one amount is missing. Never 0 for missing. */
function knownTotal(values: readonly FinancialValue[]): Decimal | null {
  const amounts: Decimal[] = [];
  for (const value of values) {
    if (value.amount === null) return null;
    amounts.push(value.amount);
  }
  return sum(amounts);
}

function toCompleteness(quality: MetricQuality): CalculationCompleteness {
  if (quality === "unavailable") return "incomplete";
  if (quality === "estimated") return "estimated";
  return "complete";
}

function validateCurrency(currency: unknown): string {
  if (typeof currency !== "string" || currency.trim() === "") {
    throw new ProfitEngineInputError(
      "INVALID_CURRENCY",
      "currency",
      "must be a non-empty currency code",
    );
  }
  return currency;
}

function validateDecimal(value: unknown, field: string): Decimal {
  if (!Decimal.isDecimal(value)) {
    throw new ProfitEngineInputError(
      "INVALID_DECIMAL",
      field,
      "must be a Decimal instance",
    );
  }
  if (!value.isFinite()) {
    throw new ProfitEngineInputError(
      "INVALID_DECIMAL",
      field,
      "must be a finite Decimal (no NaN or Infinity)",
    );
  }
  return toEngineDecimal(value);
}

function validateAmount(value: unknown, field: string): Decimal {
  const amount = validateDecimal(value, field);
  if (amount.lt(ZERO)) {
    throw new ProfitEngineInputError(
      "NEGATIVE_AMOUNT",
      field,
      `must not be negative (got ${amount.toString()})`,
    );
  }
  return amount;
}

function validateFinancialValue(value: unknown, field: string): FinancialValue {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    throw new ProfitEngineInputError(
      "INVALID_FINANCIAL_VALUE",
      field,
      "must be a FinancialValue",
    );
  }
  const { status } = value;
  const amount = "amount" in value ? value.amount : undefined;

  if (status === "missing") {
    if (amount !== null) {
      throw new ProfitEngineInputError(
        "INVALID_FINANCIAL_VALUE",
        field,
        "a missing value must have amount null",
      );
    }
    return { status: "missing", amount: null };
  }

  if (status === "verified" || status === "estimated") {
    if (amount === null || amount === undefined) {
      throw new ProfitEngineInputError(
        "INVALID_FINANCIAL_VALUE",
        field,
        `a ${status} value must have an amount`,
      );
    }
    return { status, amount: validateAmount(amount, `${field}.amount`) };
  }

  throw new ProfitEngineInputError(
    "INVALID_FINANCIAL_VALUE",
    field,
    "status must be verified, estimated or missing",
  );
}

function validateThreshold(value: unknown): Decimal {
  const field = "lowMarginThresholdPercent";
  if (!Decimal.isDecimal(value) || !value.isFinite()) {
    throw new ProfitEngineInputError(
      "INVALID_CONFIG",
      field,
      "must be a finite Decimal",
    );
  }
  const threshold = toEngineDecimal(value);
  if (threshold.lt(ZERO) || threshold.gt(ONE_HUNDRED)) {
    throw new ProfitEngineInputError(
      "INVALID_CONFIG",
      field,
      `must be between 0 and 100 (got ${threshold.toString()})`,
    );
  }
  return threshold;
}
