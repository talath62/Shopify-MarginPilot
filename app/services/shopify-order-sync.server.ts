import prisma from "../db.server.ts";
import type { AdminGraphqlClient } from "./shopify-catalog-sync.server.ts";
import { fetchOrder, OrderImportError, persistOrder } from "./shopify-order-import.server.ts";

/**
 * PG-007: refetches ONE Shopify order by GID and syncs it into PG-001 tables.
 * Reuses the PG-006 fetch, validation and transactional persistence.
 * See docs/PG-007-single-order-sync.md.
 */

export interface OrderSyncResult {
  status: "synced" | "skipped_stale";
  orderId: string;
  orderGid: string;
  /** Order lines written (0 when skipped_stale). */
  orderLines: number;
  snapshotsCreated: number;
}

export type OrderSyncErrorCode =
  | "SHOP_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "INVALID_ORDER_GID"
  | "SHOPIFY_GRAPHQL_ERROR"
  | "INVALID_SHOPIFY_DATA"
  | "INVALID_MONEY";

export class OrderSyncError extends Error {
  readonly code: OrderSyncErrorCode;

  constructor(code: OrderSyncErrorCode, message: string) {
    super(message);
    this.name = "OrderSyncError";
    this.code = code;
  }
}

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/\d+$/;

export async function syncShopifyOrderByGid({
  shopId,
  admin,
  orderGid,
}: {
  shopId: string;
  admin: AdminGraphqlClient;
  orderGid: string;
}): Promise<OrderSyncResult> {
  if (typeof orderGid !== "string" || !ORDER_GID_PATTERN.test(orderGid)) {
    throw new OrderSyncError("INVALID_ORDER_GID", `not an Order GID: ${String(orderGid)}`);
  }
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (shop === null) {
    throw new OrderSyncError("SHOP_NOT_FOUND", `no shop ${shopId}`);
  }

  try {
    // Shopify calls first, outside any DB transaction.
    const order = await fetchOrder(admin, orderGid);
    if (order === null) {
      // The local order is kept: deletion is handled by a later task.
      throw new OrderSyncError("ORDER_NOT_FOUND", `Shopify returned no order for ${orderGid}`);
    }
    if (order.shopifyGid !== orderGid) {
      throw new OrderSyncError("INVALID_SHOPIFY_DATA", `requested ${orderGid}, got ${order.shopifyGid}`);
    }

    const written = await persistOrder(shopId, order, {
      historicalApproximation: false,
      skipIfStale: true,
    });
    return {
      status: written.status,
      orderId: written.orderId,
      orderGid,
      orderLines: written.status === "synced" ? order.lines.length : 0,
      snapshotsCreated: written.snapshotsCreated,
    };
  } catch (error) {
    if (error instanceof OrderImportError) {
      // Same codes, PG-007 error type.
      throw new OrderSyncError(error.code, error.message);
    }
    throw error;
  }
}
