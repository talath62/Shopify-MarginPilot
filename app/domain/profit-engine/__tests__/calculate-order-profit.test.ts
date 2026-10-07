import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Decimal } from "../money.ts";
import {
  calculateOrderProfit,
  PROFIT_ENGINE_VERSION,
  ProfitEngineInputError,
} from "../index.ts";
import type {
  FinancialValue,
  OrderProfitInput,
  OrderProfitResult,
  ProfitEngineConfig,
} from "../index.ts";

// Inputs are built with the default Prisma Decimal, like a future normalizer reading the DB.
const d = (value: string) => new Decimal(value);
const verified = (amount: string): FinancialValue => ({
  status: "verified",
  amount: d(amount),
});
const estimated = (amount: string): FinancialValue => ({
  status: "estimated",
  amount: d(amount),
});
const missing: FinancialValue = { status: "missing", amount: null };

const config: ProfitEngineConfig = { lowMarginThresholdPercent: d("10") };

/** Reference order of the PG-002 spec, §33. */
function referenceInput(overrides: Partial<OrderProfitInput> = {}): OrderProfitInput {
  return {
    currency: "EUR",
    productRevenueExTax: d("100"),
    shippingRevenueExTax: d("10"),
    economicRefundsExTax: d("0"),
    cogs: verified("40"),
    shippingCost: verified("5"),
    paymentFees: verified("3"),
    otherCosts: verified("2"),
    adCost: verified("20"),
    ...overrides,
  };
}

/** Exact Decimal comparison through the canonical string. Never through number. */
function assertDecimal(actual: Decimal | null, expected: string) {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.equal(actual.toString(), expected);
}

function assertInputError(fn: () => unknown, code: string, field: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ProfitEngineInputError);
    assert.equal(error.code, code);
    assert.equal(error.field, field);
    return true;
  });
}

const DECIMAL_KEYS = [
  "productRevenueExTax",
  "shippingRevenueExTax",
  "economicRefundsExTax",
  "grossCommercialRevenue",
  "netRevenue",
  "operatingCostsBeforeAds",
  "profitBeforeAds",
  "maxProfitableCpa",
  "breakEvenRoas",
  "profit",
  "marginPercent",
] as const;

function assertAllFinite(result: OrderProfitResult) {
  for (const key of DECIMAL_KEYS) {
    const value = result[key];
    if (value !== null) {
      assert.ok(value.isFinite(), `${key} is not finite: ${value.toString()}`);
    }
  }
}

describe("reference formula (spec §33)", () => {
  it("computes every metric exactly", () => {
    const result = calculateOrderProfit(referenceInput(), config);

    assert.equal(result.calculationVersion, PROFIT_ENGINE_VERSION);
    assert.equal(result.currency, "EUR");
    assertDecimal(result.grossCommercialRevenue, "110");
    assertDecimal(result.netRevenue, "110");
    assertDecimal(result.operatingCostsBeforeAds, "50");
    assertDecimal(result.profitBeforeAds, "60");
    assertDecimal(result.maxProfitableCpa, "60");
    assertDecimal(result.profit, "40");
    assertDecimal(
      result.marginPercent,
      "36.363636363636363636363636363636363636363636363636",
    );
    assertDecimal(
      result.breakEvenRoas,
      "1.8333333333333333333333333333333333333333333333333",
    );
    assert.equal(result.completeness, "complete");
    assert.equal(result.profitabilityState, "PROFITABLE");
  });

  it("profitability state depends on the configured threshold", () => {
    const high = calculateOrderProfit(referenceInput(), {
      lowMarginThresholdPercent: d("40"),
    });
    assert.equal(high.profitabilityState, "LOW_MARGIN");
  });
});

describe("profitability states", () => {
  it("1. simple profitable order", () => {
    const result = calculateOrderProfit(referenceInput(), config);
    assert.equal(result.profitabilityState, "PROFITABLE");
  });

  it("2. low margin order", () => {
    // profit = 110 - 50 - 55 = 5 ; margin = 4.545...% < 10%
    const result = calculateOrderProfit(
      referenceInput({ adCost: verified("55") }),
      config,
    );
    assertDecimal(result.profit, "5");
    assert.equal(result.profitabilityState, "LOW_MARGIN");
  });

  it("3. loss order", () => {
    const result = calculateOrderProfit(
      referenceInput({ adCost: verified("75") }),
      config,
    );
    assertDecimal(result.profit, "-15");
    assert.equal(result.profitabilityState, "LOSS");
  });

  it("4. profit exactly zero is LOW_MARGIN, even with a 0 threshold", () => {
    const input = referenceInput({ adCost: verified("60") });
    const result = calculateOrderProfit(input, config);
    assertDecimal(result.profit, "0");
    assertDecimal(result.marginPercent, "0");
    assert.equal(result.profitabilityState, "LOW_MARGIN");

    const zeroThreshold = calculateOrderProfit(input, {
      lowMarginThresholdPercent: d("0"),
    });
    assert.equal(zeroThreshold.profitabilityState, "LOW_MARGIN");
  });

  it("33. margin just under the threshold is LOW_MARGIN", () => {
    // netRevenue 100, profit 9.999999 => margin 9.999999%
    const result = calculateOrderProfit(
      referenceInput({
        productRevenueExTax: d("100"),
        shippingRevenueExTax: d("0"),
        adCost: verified("40.000001"),
      }),
      config,
    );
    assertDecimal(result.marginPercent, "9.999999");
    assert.equal(result.profitabilityState, "LOW_MARGIN");
  });

  it("34. margin exactly at the threshold is PROFITABLE", () => {
    const result = calculateOrderProfit(
      referenceInput({
        productRevenueExTax: d("100"),
        shippingRevenueExTax: d("0"),
        adCost: verified("40"),
      }),
      config,
    );
    assertDecimal(result.marginPercent, "10");
    assert.equal(result.profitabilityState, "PROFITABLE");
  });

  it("35. margin just above the threshold is PROFITABLE", () => {
    const result = calculateOrderProfit(
      referenceInput({
        productRevenueExTax: d("100"),
        shippingRevenueExTax: d("0"),
        adCost: verified("39.999999"),
      }),
      config,
    );
    assertDecimal(result.marginPercent, "10.000001");
    assert.equal(result.profitabilityState, "PROFITABLE");
  });
});

describe("shipping revenue and shipping cost stay separate", () => {
  it("5. free shipping for the customer but a real shipping cost", () => {
    const result = calculateOrderProfit(
      referenceInput({ shippingRevenueExTax: d("0"), shippingCost: verified("7") }),
      config,
    );
    assertDecimal(result.grossCommercialRevenue, "100");
    assertDecimal(result.operatingCostsBeforeAds, "52");
    assertDecimal(result.profitBeforeAds, "48");
    assertDecimal(result.profit, "28");
    assert.equal(result.shippingCost.status, "verified");
  });
});

describe("missing costs", () => {
  for (const field of ["cogs", "shippingCost", "paymentFees", "otherCosts"] as const) {
    it(`${field} missing: revenue available, everything after costs unavailable`, () => {
      const result = calculateOrderProfit(referenceInput({ [field]: missing }), config);

      assertDecimal(result.grossCommercialRevenue, "110");
      assertDecimal(result.netRevenue, "110");
      assert.equal(result.operatingCostsBeforeAds, null);
      assert.equal(result.profitBeforeAds, null);
      assert.equal(result.maxProfitableCpa, null);
      assert.equal(result.breakEvenRoas, null);
      assert.equal(result.profit, null);
      assert.equal(result.marginPercent, null);
      assert.equal(result.quality.netRevenue, "verified");
      assert.equal(result.quality.profitBeforeAds, "unavailable");
      assert.equal(result.quality.profit, "unavailable");
      assert.equal(result.completeness, "incomplete");
      assert.equal(result.profitabilityState, "INCOMPLETE");
      assert.deepEqual(result[field], missing);
    });
  }

  it("9. adCost missing: acquisition capacity known, final profit unavailable (spec §34)", () => {
    const result = calculateOrderProfit(referenceInput({ adCost: missing }), config);

    assertDecimal(result.grossCommercialRevenue, "110");
    assertDecimal(result.netRevenue, "110");
    assertDecimal(result.operatingCostsBeforeAds, "50");
    assertDecimal(result.profitBeforeAds, "60");
    assertDecimal(result.maxProfitableCpa, "60");
    assertDecimal(
      result.breakEvenRoas,
      "1.8333333333333333333333333333333333333333333333333",
    );
    assert.equal(result.profit, null);
    assert.equal(result.marginPercent, null);
    assert.equal(result.quality.profitBeforeAds, "verified");
    assert.equal(result.quality.maxProfitableCpa, "verified");
    assert.equal(result.quality.breakEvenRoas, "verified");
    assert.equal(result.quality.profit, "unavailable");
    assert.equal(result.quality.marginPercent, "unavailable");
    assert.equal(result.completeness, "incomplete");
    assert.equal(result.profitabilityState, "INCOMPLETE");
  });

  it("25. verified 0 is a known cost, missing is not", () => {
    const zero = calculateOrderProfit(
      referenceInput({ otherCosts: verified("0"), adCost: verified("0") }),
      config,
    );
    assertDecimal(zero.profit, "62");
    assert.equal(zero.completeness, "complete");

    const unknown = calculateOrderProfit(
      referenceInput({ otherCosts: missing, adCost: missing }),
      config,
    );
    assert.equal(unknown.profit, null);
    assert.equal(unknown.completeness, "incomplete");
  });
});

describe("estimated costs", () => {
  it("11. one estimated cost: metrics computed and marked estimated (spec §36)", () => {
    const result = calculateOrderProfit(
      referenceInput({ paymentFees: estimated("3") }),
      config,
    );
    assertDecimal(result.profitBeforeAds, "60");
    assertDecimal(result.profit, "40");
    assert.equal(result.quality.netRevenue, "verified");
    assert.equal(result.quality.operatingCostsBeforeAds, "estimated");
    assert.equal(result.quality.profitBeforeAds, "estimated");
    assert.equal(result.quality.maxProfitableCpa, "estimated");
    assert.equal(result.quality.breakEvenRoas, "estimated");
    assert.equal(result.quality.profit, "estimated");
    assert.equal(result.quality.marginPercent, "estimated");
    assert.equal(result.completeness, "estimated");
    assert.equal(result.profitabilityState, "PROFITABLE");
  });

  it("estimated adCost only affects final profit quality", () => {
    const result = calculateOrderProfit(
      referenceInput({ adCost: estimated("20") }),
      config,
    );
    assert.equal(result.quality.profitBeforeAds, "verified");
    assert.equal(result.quality.profit, "estimated");
    assert.equal(result.completeness, "estimated");
  });

  it("12. several estimated costs", () => {
    const result = calculateOrderProfit(
      referenceInput({
        cogs: estimated("40"),
        shippingCost: estimated("5"),
        adCost: estimated("20"),
      }),
      config,
    );
    assertDecimal(result.profit, "40");
    assert.equal(result.completeness, "estimated");
  });

  it("estimated plus missing is incomplete", () => {
    const result = calculateOrderProfit(
      referenceInput({ cogs: estimated("40"), adCost: missing }),
      config,
    );
    assert.equal(result.quality.profitBeforeAds, "estimated");
    assert.equal(result.completeness, "incomplete");
  });

  it("13. all costs verified: complete", () => {
    const result = calculateOrderProfit(referenceInput(), config);
    assert.equal(result.completeness, "complete");
    assert.equal(result.quality.profit, "verified");
  });
});

describe("refunds", () => {
  it("14. partial refund", () => {
    const result = calculateOrderProfit(
      referenceInput({ economicRefundsExTax: d("30") }),
      config,
    );
    assertDecimal(result.grossCommercialRevenue, "110");
    assertDecimal(result.netRevenue, "80");
    assertDecimal(result.profitBeforeAds, "30");
    assertDecimal(result.profit, "10");
    assertDecimal(result.marginPercent, "12.5");
  });

  it("15. total refund", () => {
    const result = calculateOrderProfit(
      referenceInput({ economicRefundsExTax: d("110") }),
      config,
    );
    assertDecimal(result.netRevenue, "0");
    assertDecimal(result.profit, "-70");
    assert.equal(result.marginPercent, null);
    assert.equal(result.quality.marginPercent, "unavailable");
    assert.equal(result.profitabilityState, "LOSS");
  });

  it("16. refund larger than revenue", () => {
    const result = calculateOrderProfit(
      referenceInput({ economicRefundsExTax: d("150") }),
      config,
    );
    assertDecimal(result.netRevenue, "-40");
    assertDecimal(result.profitBeforeAds, "-90");
    assertDecimal(result.maxProfitableCpa, "0");
    assert.equal(result.breakEvenRoas, null);
    assertDecimal(result.profit, "-110");
    assert.equal(result.marginPercent, null);
    assert.equal(result.profitabilityState, "LOSS");
    assertAllFinite(result);
  });

  it("17. netRevenue = 0 with no costs: margin unavailable, never a division by zero", () => {
    const result = calculateOrderProfit(
      {
        currency: "EUR",
        productRevenueExTax: d("0"),
        shippingRevenueExTax: d("0"),
        economicRefundsExTax: d("0"),
        cogs: verified("0"),
        shippingCost: verified("0"),
        paymentFees: verified("0"),
        otherCosts: verified("0"),
        adCost: verified("0"),
      },
      config,
    );
    assertDecimal(result.netRevenue, "0");
    assertDecimal(result.profit, "0");
    assert.equal(result.marginPercent, null);
    assert.equal(result.breakEvenRoas, null);
    assert.equal(result.profitabilityState, "LOW_MARGIN");
    assertAllFinite(result);
  });
});

describe("CPA max and break-even ROAS", () => {
  it("18. negative profit before ads: CPA max 0, ROAS null", () => {
    const result = calculateOrderProfit(referenceInput({ cogs: verified("110") }), config);
    assertDecimal(result.profitBeforeAds, "-10");
    assertDecimal(result.maxProfitableCpa, "0");
    assert.equal(result.breakEvenRoas, null);
    assert.equal(result.quality.maxProfitableCpa, "verified");
    assert.equal(result.quality.breakEvenRoas, "unavailable");
  });

  it("19. profit before ads = 0: CPA max 0, ROAS null", () => {
    const result = calculateOrderProfit(referenceInput({ cogs: verified("100") }), config);
    assertDecimal(result.profitBeforeAds, "0");
    assertDecimal(result.maxProfitableCpa, "0");
    assert.equal(result.breakEvenRoas, null);
  });

  it("20. positive profit before ads: CPA max equals it", () => {
    const result = calculateOrderProfit(referenceInput({ cogs: verified("25.5") }), config);
    assertDecimal(result.profitBeforeAds, "74.5");
    assertDecimal(result.maxProfitableCpa, "74.5");
  });

  it("21. break-even ROAS = netRevenue / CPA max", () => {
    // netRevenue 110, costs 50 + 0 + 3 + 2 = 55, profitBeforeAds 55 => ROAS 2
    const result = calculateOrderProfit(
      referenceInput({ cogs: verified("50"), shippingCost: verified("0") }),
      config,
    );
    assertDecimal(result.maxProfitableCpa, "55");
    assertDecimal(result.breakEvenRoas, "2");
  });
});

describe("decimal precision", () => {
  it("22. long division keeps 50 significant digits (no number conversion)", () => {
    // netRevenue 100, profitBeforeAds 3 => ROAS 100/3
    const result = calculateOrderProfit(
      {
        ...referenceInput(),
        productRevenueExTax: d("100"),
        shippingRevenueExTax: d("0"),
        cogs: verified("97"),
        shippingCost: verified("0"),
        paymentFees: verified("0"),
        otherCosts: verified("0"),
      },
      config,
    );
    assertDecimal(
      result.breakEvenRoas,
      "33.333333333333333333333333333333333333333333333333",
    );
    // A JS number would keep at most 17 significant digits.
    assert.ok(result.breakEvenRoas!.precision() > 17);
  });

  it("23. amounts with 6 decimals stay exact", () => {
    const result = calculateOrderProfit(
      {
        currency: "EUR",
        productRevenueExTax: d("123.456789"),
        shippingRevenueExTax: d("0.000001"),
        economicRefundsExTax: d("0.000001"),
        cogs: verified("23.456788"),
        shippingCost: verified("0"),
        paymentFees: verified("0"),
        otherCosts: verified("0"),
        adCost: verified("0"),
      },
      config,
    );
    assertDecimal(result.grossCommercialRevenue, "123.45679");
    assertDecimal(result.netRevenue, "123.456789");
    assertDecimal(result.profit, "100.000001");
    assertDecimal(
      result.marginPercent,
      "81.000001547100014078610128115352165849704709232313",
    );
  });

  it("24. very large DECIMAL(20,6) amounts are added without rounding", () => {
    const max = "99999999999999.999999";
    const result = calculateOrderProfit(
      {
        currency: "EUR",
        productRevenueExTax: d(max),
        shippingRevenueExTax: d(max),
        economicRefundsExTax: d("0"),
        cogs: verified("0.000001"),
        shippingCost: verified("0"),
        paymentFees: verified("0"),
        otherCosts: verified("0"),
        adCost: verified("0"),
      },
      config,
    );
    // 21 significant digits: the default 20-digit Decimal would have rounded it.
    assertDecimal(result.grossCommercialRevenue, "199999999999999.999998");
    assertDecimal(result.profit, "199999999999999.999997");
  });
});

describe("input validation", () => {
  for (const field of ["cogs", "shippingCost", "paymentFees", "adCost", "otherCosts"] as const) {
    it(`26. negative ${field} is rejected`, () => {
      assertInputError(
        () => calculateOrderProfit(referenceInput({ [field]: verified("-0.01") }), config),
        "NEGATIVE_AMOUNT",
        `${field}.amount`,
      );
      assertInputError(
        () => calculateOrderProfit(referenceInput({ [field]: estimated("-1") }), config),
        "NEGATIVE_AMOUNT",
        `${field}.amount`,
      );
    });
  }

  it("27. negative revenue is rejected", () => {
    assertInputError(
      () => calculateOrderProfit(referenceInput({ productRevenueExTax: d("-1") }), config),
      "NEGATIVE_AMOUNT",
      "productRevenueExTax",
    );
    assertInputError(
      () => calculateOrderProfit(referenceInput({ shippingRevenueExTax: d("-1") }), config),
      "NEGATIVE_AMOUNT",
      "shippingRevenueExTax",
    );
  });

  it("28. negative refund is rejected", () => {
    assertInputError(
      () => calculateOrderProfit(referenceInput({ economicRefundsExTax: d("-5") }), config),
      "NEGATIVE_AMOUNT",
      "economicRefundsExTax",
    );
  });

  it("29. empty currency is rejected", () => {
    assertInputError(
      () => calculateOrderProfit(referenceInput({ currency: "" }), config),
      "INVALID_CURRENCY",
      "currency",
    );
    assertInputError(
      () => calculateOrderProfit(referenceInput({ currency: "   " }), config),
      "INVALID_CURRENCY",
      "currency",
    );
  });

  it("30. invalid LOW_MARGIN threshold is rejected", () => {
    for (const value of ["-0.000001", "100.000001", "NaN", "Infinity"]) {
      assertInputError(
        () => calculateOrderProfit(referenceInput(), { lowMarginThresholdPercent: d(value) }),
        "INVALID_CONFIG",
        "lowMarginThresholdPercent",
      );
    }
    assertInputError(
      () =>
        calculateOrderProfit(referenceInput(), {
          lowMarginThresholdPercent: 10 as unknown as Decimal,
        }),
      "INVALID_CONFIG",
      "lowMarginThresholdPercent",
    );
  });

  it("missing with an amount is rejected", () => {
    assertInputError(
      () =>
        calculateOrderProfit(
          referenceInput({ cogs: { status: "missing", amount: d("0") } as unknown as FinancialValue }),
          config,
        ),
      "INVALID_FINANCIAL_VALUE",
      "cogs",
    );
  });

  it("verified or estimated without an amount is rejected", () => {
    for (const status of ["verified", "estimated"]) {
      assertInputError(
        () =>
          calculateOrderProfit(
            referenceInput({ cogs: { status, amount: null } as unknown as FinancialValue }),
            config,
          ),
        "INVALID_FINANCIAL_VALUE",
        "cogs",
      );
    }
  });

  it("unknown status is rejected", () => {
    assertInputError(
      () =>
        calculateOrderProfit(
          referenceInput({ cogs: { status: "zero", amount: null } as unknown as FinancialValue }),
          config,
        ),
      "INVALID_FINANCIAL_VALUE",
      "cogs",
    );
  });

  it("JS numbers, NaN and Infinity are rejected as amounts", () => {
    assertInputError(
      () =>
        calculateOrderProfit(
          referenceInput({ productRevenueExTax: 100 as unknown as Decimal }),
          config,
        ),
      "INVALID_DECIMAL",
      "productRevenueExTax",
    );
    assertInputError(
      () => calculateOrderProfit(referenceInput({ productRevenueExTax: d("NaN") }), config),
      "INVALID_DECIMAL",
      "productRevenueExTax",
    );
    assertInputError(
      () => calculateOrderProfit(referenceInput({ cogs: verified("Infinity") }), config),
      "INVALID_DECIMAL",
      "cogs.amount",
    );
  });
});

describe("purity", () => {
  it("31. deterministic: two identical calls give the same result", () => {
    const first = calculateOrderProfit(referenceInput({ paymentFees: estimated("3.3") }), config);
    const second = calculateOrderProfit(referenceInput({ paymentFees: estimated("3.3") }), config);
    assert.deepStrictEqual(first, second);
    for (const key of DECIMAL_KEYS) {
      assert.equal(String(first[key]), String(second[key]));
    }
  });

  it("does not mutate its input", () => {
    const input = referenceInput({ economicRefundsExTax: d("12.5") });
    for (const value of Object.values(input)) {
      if (typeof value === "object" && value !== null) Object.freeze(value);
    }
    Object.freeze(input);
    const before = JSON.stringify(input);
    calculateOrderProfit(input, Object.freeze({ ...config }));
    assert.equal(JSON.stringify(input), before);
  });

  it("32. no NaN or Infinity in any scenario", () => {
    const scenarios: Partial<OrderProfitInput>[] = [
      {},
      { economicRefundsExTax: d("110") },
      { economicRefundsExTax: d("1000") },
      { cogs: verified("100") },
      { cogs: verified("1000") },
      { adCost: missing },
      { cogs: missing },
      { productRevenueExTax: d("0"), shippingRevenueExTax: d("0") },
      {
        productRevenueExTax: d("0"),
        shippingRevenueExTax: d("0"),
        cogs: verified("0"),
        shippingCost: verified("0"),
        paymentFees: verified("0"),
        otherCosts: verified("0"),
        adCost: verified("0"),
      },
    ];
    for (const overrides of scenarios) {
      assertAllFinite(calculateOrderProfit(referenceInput(overrides), config));
    }
  });
});
