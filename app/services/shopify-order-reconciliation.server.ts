import prisma from "../db.server.ts";
import type { AdminGraphqlClient } from "./shopify-catalog-sync.server.ts";
import { syncShopifyOrderByGid } from "./shopify-order-sync.server.ts";

/**
 * PG-008: finds the Shopify orders updated in [updatedSince, updatedUntil) and
 * syncs each one with PG-007. No checkpoint is stored: the caller owns the window.
 * See docs/PG-008-order-reconciliation.md.
 */

export interface ReconciliationResult {
  /** Unique order GIDs returned by Shopify for the window. */
  discovered: number;
  synced: number;
  skippedStale: number;
  snapshotsCreated: number;
}

export type ReconciliationErrorCode =
  | "INVALID_WINDOW"
  | "SHOP_NOT_FOUND"
  | "SHOPIFY_GRAPHQL_ERROR"
  | "INVALID_SHOPIFY_DATA";

export class ReconciliationError extends Error {
  readonly code: ReconciliationErrorCode;

  constructor(code: ReconciliationErrorCode, message: string) {
    super(message);
    this.name = "ReconciliationError";
    this.code = code;
  }
}

const ORDERS_UPDATED_QUERY = `#graphql
  query OrderReconciliationPage($cursor: String, $query: String!) {
    orders(first: 100, after: $cursor, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { id updatedAt }
    }
  }
`;

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/\d+$/;

/** Shopify search filter for [since, until), as quoted UTC ISO 8601 dates. */
export function buildUpdatedWindowQuery(updatedSince: Date, updatedUntil: Date): string {
  return `updated_at:>='${updatedSince.toISOString()}' updated_at:<'${updatedUntil.toISOString()}'`;
}

export async function reconcileShopifyOrders({
  shopId,
  admin,
  updatedSince,
  updatedUntil,
}: {
  shopId: string;
  admin: AdminGraphqlClient;
  updatedSince: Date;
  updatedUntil: Date;
}): Promise<ReconciliationResult> {
  // The window is always explicit: no default, no implicit "now".
  for (const [name, value] of [["updatedSince", updatedSince], ["updatedUntil", updatedUntil]] as const) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ReconciliationError("INVALID_WINDOW", `${name} must be a valid Date`);
    }
  }
  if (updatedSince.getTime() >= updatedUntil.getTime()) {
    throw new ReconciliationError("INVALID_WINDOW", "updatedSince must be before updatedUntil");
  }
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (shop === null) {
    throw new ReconciliationError("SHOP_NOT_FOUND", `no shop ${shopId}`);
  }

  // 1. Collect every unique GID of the window (all pages) before syncing.
  const query = buildUpdatedWindowQuery(updatedSince, updatedUntil);
  const orderGids = new Set<string>();
  let cursor: string | null = null;
  do {
    const data = await runQuery(admin, { cursor, query });
    const connection = data.orders as { nodes?: unknown; pageInfo?: unknown } | null | undefined;
    if (typeof connection !== "object" || connection === null || !Array.isArray(connection.nodes)) {
      throw new ReconciliationError("INVALID_SHOPIFY_DATA", "orders: invalid connection");
    }
    for (const node of connection.nodes) {
      const id = (node as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || !ORDER_GID_PATTERN.test(id)) {
        throw new ReconciliationError("INVALID_SHOPIFY_DATA", `invalid order id: ${String(id)}`);
      }
      orderGids.add(id);
    }
    cursor = nextCursor(connection.pageInfo);
  } while (cursor !== null);

  // 2. Sequential sync through PG-007. Its errors (ORDER_NOT_FOUND included)
  // propagate and stop the run; orders already synced keep their own transaction.
  const result: ReconciliationResult = {
    discovered: orderGids.size,
    synced: 0,
    skippedStale: 0,
    snapshotsCreated: 0,
  };
  for (const orderGid of orderGids) {
    const synced = await syncShopifyOrderByGid({ shopId, admin, orderGid });
    if (synced.status === "synced") result.synced += 1;
    else result.skippedStale += 1;
    result.snapshotsCreated += synced.snapshotsCreated;
  }
  return result;
}

async function runQuery(
  admin: AdminGraphqlClient,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let body: { data?: Record<string, unknown> | null; errors?: unknown };
  try {
    const response = await admin.graphql(ORDERS_UPDATED_QUERY, { variables });
    body = (await response.json()) as typeof body;
  } catch (error) {
    throw new ReconciliationError(
      "SHOPIFY_GRAPHQL_ERROR",
      `Shopify GraphQL call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (body.errors !== undefined && body.errors !== null) {
    throw new ReconciliationError("SHOPIFY_GRAPHQL_ERROR", `Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) {
    throw new ReconciliationError("INVALID_SHOPIFY_DATA", "GraphQL response has no data");
  }
  return body.data;
}

/** Same strict rule as PG-005/006: a malformed pageInfo is never treated as the last page. */
function nextCursor(pageInfo: unknown): string | null {
  if (typeof pageInfo !== "object" || pageInfo === null) {
    throw new ReconciliationError("INVALID_SHOPIFY_DATA", "pageInfo is not an object");
  }
  const { hasNextPage, endCursor } = pageInfo as { hasNextPage?: unknown; endCursor?: unknown };
  if (typeof hasNextPage !== "boolean") {
    throw new ReconciliationError("INVALID_SHOPIFY_DATA", "pageInfo.hasNextPage is not a boolean");
  }
  if (hasNextPage === false) return null;
  if (typeof endCursor !== "string" || endCursor === "") {
    throw new ReconciliationError("INVALID_SHOPIFY_DATA", "hasNextPage without a valid endCursor");
  }
  return endCursor;
}
