import { Prisma } from "@prisma/client";

// Public Prisma API. Only the Decimal class is used: no PrismaClient, no DB access.
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

/**
 * Decimal constructor used for every engine computation.
 *
 * - 50 significant digits: additions, subtractions and multiplications of
 *   DECIMAL(20,6) amounts are exact (no rounding at all).
 * - Only a division can produce a non-terminating result (e.g. 110 / 60).
 *   Its result is cut at 50 significant digits with ROUND_HALF_EVEN.
 *
 * The default Decimal constructor (20 significant digits) is never used for
 * arithmetic: it would silently round large sums.
 */
export const EngineDecimal = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_EVEN,
});

export const ZERO: Decimal = new EngineDecimal(0);
export const ONE_HUNDRED: Decimal = new EngineDecimal(100);

/** Copies a caller Decimal into the engine constructor. The constructor never rounds. */
export function toEngineDecimal(value: Decimal): Decimal {
  return new EngineDecimal(value);
}

export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), ZERO);
}
