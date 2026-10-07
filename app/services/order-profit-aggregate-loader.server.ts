import type { Prisma } from "@prisma/client";

import prisma from "../db.server.ts";
import type { OrderProfitNormalizationSource } from "../domain/order-profit-normalizer/index.ts";

/**
 * PG-004: loads ONE complete order aggregate from PostgreSQL and maps it to the
 * PG-003 OrderProfitNormalizationSource (see docs/PG-004-order-profit-aggregate-loader.md).
 * Infrastructure only: no financial rule, no filtering, no Shopify call.
 */

export type OrderProfitAggregateLoadErrorCode =
  | "ORDER_NOT_FOUND"
  | "ORDER_DELETED"
  | "INCONSISTENT_PERSISTED_DATA";

export class OrderProfitAggregateLoadError extends Error {
  readonly code: OrderProfitAggregateLoadErrorCode;
  readonly context: Readonly<Record<string, string>>;

  constructor(
    code: OrderProfitAggregateLoadErrorCode,
    message: string,
    context: Record<string, string>,
  ) {
    super(message);
    this.name = "OrderProfitAggregateLoadError";
    this.code = code;
    this.context = context;
  }
}

const amountSelect = { amount: true, currencyCode: true } as const;
const byPosition = { position: "asc" } as const;
const byId = { id: "asc" } as const;

/** Only the columns PG-003 needs. No catalog, no shop, no customer data. */
export const orderAggregateSelect = {
  id: true,
  shopId: true,
  currencyCode: true,
  taxesIncluded: true,
  test: true,
  deletedAt: true,
  lines: {
    orderBy: byId,
    select: {
      id: true,
      quantity: true,
      isGiftCard: true,
      originalTotal: true,
      currencyCode: true,
      discountAllocations: { orderBy: byPosition, select: amountSelect },
      taxes: { orderBy: byPosition, select: amountSelect },
      costSnapshot: {
        select: {
          unitCost: true,
          currencyCode: true,
          source: true,
          historicalApproximation: true,
        },
      },
    },
  },
  shippingLines: {
    orderBy: byPosition,
    select: {
      isRemoved: true,
      discountedPrice: true,
      currencyCode: true,
      taxes: { orderBy: byPosition, select: amountSelect },
    },
  },
  transactions: {
    orderBy: byId,
    select: {
      id: true,
      refundId: true,
      kind: true,
      status: true,
      gateway: true,
      amount: true,
      currencyCode: true,
      test: true,
      fees: { orderBy: byPosition, select: amountSelect },
    },
  },
  refunds: {
    orderBy: byId,
    select: {
      id: true,
      totalRefunded: true,
      currencyCode: true,
      lines: {
        orderBy: byPosition,
        select: {
          orderLineId: true,
          quantity: true,
          subtotal: true,
          taxAmount: true,
          currencyCode: true,
          restockType: true,
        },
      },
      shippingLines: {
        orderBy: byPosition,
        select: { subtotalAmount: true, taxAmount: true, currencyCode: true },
      },
      adjustments: {
        orderBy: byPosition,
        select: { reason: true, amount: true, taxAmount: true, currencyCode: true },
      },
    },
  },
} as const satisfies Prisma.OrderSelect;

export type PersistedOrderAggregate = Prisma.OrderGetPayload<{
  select: typeof orderAggregateSelect;
}>;

/**
 * Loads the complete aggregate of order `orderId` of shop `shopId`.
 * The tenant filter is part of the root query. Throws OrderProfitAggregateLoadError.
 */
export async function loadOrderProfitNormalizationSource(
  shopId: string,
  orderId: string,
): Promise<OrderProfitNormalizationSource> {
  // Prisma reads nested relations with several SQL statements. A REPEATABLE READ
  // transaction gives them one PostgreSQL snapshot: no mix of two order states.
  const order = await prisma.$transaction(
    (tx) =>
      tx.order.findFirst({
        where: { id: orderId, shopId },
        select: orderAggregateSelect,
      }),
    { isolationLevel: "RepeatableRead" },
  );

  if (order === null) {
    throw new OrderProfitAggregateLoadError(
      "ORDER_NOT_FOUND",
      "no order with this id in this shop",
      { shopId, orderId },
    );
  }
  if (order.deletedAt !== null) {
    throw new OrderProfitAggregateLoadError(
      "ORDER_DELETED",
      "order is soft-deleted (orders/delete) and excluded from profit",
      { shopId, orderId },
    );
  }
  return mapPersistedOrderToNormalizationSource(order);
}

/**
 * Pure mapping PG-001 row -> PG-003 DTO. Keeps every row, every Decimal and every null.
 * Only checks structural invariants that the schema does not enforce per order.
 */
export function mapPersistedOrderToNormalizationSource(
  order: PersistedOrderAggregate,
): OrderProfitNormalizationSource {
  const context = { shopId: order.shopId, orderId: order.id };
  const lineIds = new Set(order.lines.map((line) => line.id));
  const refundIds = new Set(order.refunds.map((refund) => refund.id));

  // FKs are tenant-safe but not order-scoped: a link to another order of the
  // same shop would silently corrupt the aggregate.
  for (const transaction of order.transactions) {
    if (transaction.refundId !== null && !refundIds.has(transaction.refundId)) {
      throw new OrderProfitAggregateLoadError(
        "INCONSISTENT_PERSISTED_DATA",
        "transaction references a refund of another order",
        { ...context, transactionId: transaction.id, refundId: transaction.refundId },
      );
    }
  }
  for (const refund of order.refunds) {
    for (const line of refund.lines) {
      if (!lineIds.has(line.orderLineId)) {
        throw new OrderProfitAggregateLoadError(
          "INCONSISTENT_PERSISTED_DATA",
          "refund line references an order line of another order",
          { ...context, refundId: refund.id, orderLineId: line.orderLineId },
        );
      }
    }
  }

  return {
    order: {
      currencyCode: order.currencyCode,
      taxesIncluded: order.taxesIncluded,
      test: order.test,
    },
    orderLines: order.lines.map((line) => ({
      id: line.id,
      quantity: line.quantity,
      isGiftCard: line.isGiftCard,
      originalTotal: line.originalTotal,
      currencyCode: line.currencyCode,
      discountAllocations: line.discountAllocations.map(toAmount),
      taxLines: line.taxes.map(toAmount),
      costSnapshot:
        line.costSnapshot === null
          ? null
          : {
              unitCost: line.costSnapshot.unitCost,
              currencyCode: line.costSnapshot.currencyCode,
              source: line.costSnapshot.source,
              historicalApproximation: line.costSnapshot.historicalApproximation,
            },
    })),
    shippingLines: order.shippingLines.map((line) => ({
      isRemoved: line.isRemoved,
      discountedPrice: line.discountedPrice,
      currencyCode: line.currencyCode,
      taxLines: line.taxes.map(toAmount),
    })),
    transactions: order.transactions.map((transaction) => ({
      id: transaction.id,
      refundId: transaction.refundId,
      kind: transaction.kind,
      status: transaction.status,
      gateway: transaction.gateway,
      amount: transaction.amount,
      currencyCode: transaction.currencyCode,
      test: transaction.test,
      fees: transaction.fees.map(toAmount),
    })),
    refunds: order.refunds.map((refund) => ({
      id: refund.id,
      totalRefunded: refund.totalRefunded,
      currencyCode: refund.currencyCode,
      lines: refund.lines.map((line) => ({
        orderLineId: line.orderLineId,
        quantity: line.quantity,
        subtotal: line.subtotal,
        taxAmount: line.taxAmount,
        currencyCode: line.currencyCode,
        restockType: line.restockType,
      })),
      shippingLines: refund.shippingLines.map((line) => ({
        subtotalAmount: line.subtotalAmount,
        taxAmount: line.taxAmount,
        currencyCode: line.currencyCode,
      })),
      adjustments: refund.adjustments.map((adjustment) => ({
        reason: adjustment.reason,
        amount: adjustment.amount,
        taxAmount: adjustment.taxAmount,
        currencyCode: adjustment.currencyCode,
      })),
    })),
  };
}

function toAmount(row: { amount: Prisma.Decimal; currencyCode: string }) {
  return { amount: row.amount, currencyCode: row.currencyCode };
}
