import prisma from "../db.server.ts";
import { enqueueJob } from "./job-queue.server.ts";
import type { JobPayloads } from "./job-queue.server.ts";

/**
 * PG-010: maps an AUTHENTICATED Shopify webhook to a PG-009 job and enqueues it.
 * Reception only: no Shopify call, no sync in the HTTP request.
 * See docs/PG-010-shopify-webhooks.md.
 */

export const ORDER_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "REFUNDS_CREATE"] as const;
export const CATALOG_TOPICS = ["PRODUCTS_CREATE", "PRODUCTS_UPDATE", "PRODUCTS_DELETE", "INVENTORY_ITEMS_UPDATE"] as const;
export const CATALOG_DEDUPE_KEY = "catalog:full";

type RoutedJob =
  | { type: "ORDER_SYNC"; payload: JobPayloads["ORDER_SYNC"]; dedupeKey: string }
  | { type: "CATALOG_SYNC"; payload: JobPayloads["CATALOG_SYNC"]; dedupeKey: string };

export type WebhookDispatchResult =
  | { status: "enqueued"; jobId: string; deduplicated: boolean; jobType: RoutedJob["type"] }
  | { status: "ignored"; reason: "unknown_shop" | "inactive_shop" | "no_session" };

/** Payload or topic that cannot be routed. Never retried usefully: answered non-2xx, no job. */
export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/\d+$/;
const DECIMAL_ID_PATTERN = /^[1-9]\d*$/;

/** "orders/create" and "ORDERS_CREATE" (the SDK form) both become "ORDERS_CREATE". */
export function normalizeTopic(topic: string): string {
  return topic.trim().replace(/\//g, "_").toUpperCase();
}

/**
 * Pure routing: topic + payload -> job. Reads only the fields needed for routing;
 * the Shopify payload is never copied into the job.
 */
export function routeWebhook(topic: string, payload: unknown, rawOrderId?: string): RoutedJob {
  const normalized = normalizeTopic(topic);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new WebhookPayloadError(`${normalized}: payload is not an object`);
  }
  const body = payload as Record<string, unknown>;

  if (normalized === "ORDERS_CREATE" || normalized === "ORDERS_UPDATED") {
    const orderGid = body.admin_graphql_api_id;
    if (typeof orderGid !== "string" || !ORDER_GID_PATTERN.test(orderGid)) {
      throw new WebhookPayloadError(`${normalized}: admin_graphql_api_id is not an Order GID`);
    }
    return { type: "ORDER_SYNC", payload: { orderGid }, dedupeKey: orderGid };
  }

  if (normalized === "REFUNDS_CREATE") {
    // The refund's own id/admin_graphql_api_id is NOT the order: use order_id.
    const orderGid = `gid://shopify/Order/${parentOrderId(body.order_id, rawOrderId)}`;
    return { type: "ORDER_SYNC", payload: { orderGid }, dedupeKey: orderGid };
  }

  if ((CATALOG_TOPICS as readonly string[]).includes(normalized)) {
    // PG-005 runs a full catalog sync: one shared key coalesces bursts of events.
    return { type: "CATALOG_SYNC", payload: {}, dedupeKey: CATALOG_DEDUPE_KEY };
  }

  throw new WebhookPayloadError(`unsupported topic ${normalized}`);
}

/**
 * Exact decimal string of the parent order id.
 * - JSON string: used as is when it is a decimal id.
 * - JSON number: `rawOrderId` (its source text in the verified raw body) gives the
 *   exact digits, even above Number.MAX_SAFE_INTEGER. Without it, only a safe
 *   integer is accepted: a rounded value is never used.
 */
function parentOrderId(value: unknown, rawOrderId?: string): string {
  if (typeof value === "string") {
    if (DECIMAL_ID_PATTERN.test(value)) return value;
  } else if (typeof value === "number") {
    if (rawOrderId !== undefined) {
      if (DECIMAL_ID_PATTERN.test(rawOrderId)) return rawOrderId;
    } else if (Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
  }
  throw new WebhookPayloadError("REFUNDS_CREATE: order_id is not a valid positive integer id");
}

/**
 * Source text of a top-level primitive field, read from the raw JSON body with the
 * Node.js 22 JSON.parse reviver `context.source` (no precision loss).
 * Returns undefined if the field is absent, not top-level, or not a primitive.
 */
export function topLevelSourceOf(rawBody: string, key: string): string | undefined {
  const sources = new Map<object, string>();
  const reviver = function (this: object, field: string, value: unknown, context?: { source?: string }) {
    if (field === key && typeof context?.source === "string") sources.set(this, context.source);
    return value;
  };
  const root: unknown = JSON.parse(rawBody, reviver as unknown as (key: string, value: unknown) => unknown);
  return typeof root === "object" && root !== null ? sources.get(root) : undefined;
}

/**
 * Routes the webhook, resolves the shop from its persisted myshopifyDomain and
 * enqueues the job. Returns only after the job is persisted (or deduplicated).
 * A shop that is unknown, inactive or without session (uninstalled) gets no job.
 */
export async function dispatchShopifyWebhook({
  topic,
  shopDomain,
  payload,
  hasSession,
  rawOrderId,
}: {
  topic: string;
  shopDomain: string;
  payload: unknown;
  hasSession: boolean;
  /** REFUNDS_CREATE only: exact source text of order_id from the verified raw body. */
  rawOrderId?: string;
}): Promise<WebhookDispatchResult> {
  const job = routeWebhook(topic, payload, rawOrderId);

  if (!hasSession) return { status: "ignored", reason: "no_session" };
  const shop = await prisma.shop.findUnique({
    where: { myshopifyDomain: shopDomain },
    select: { id: true, isActive: true, uninstalledAt: true },
  });
  if (shop === null) return { status: "ignored", reason: "unknown_shop" };
  if (!shop.isActive || shop.uninstalledAt !== null) return { status: "ignored", reason: "inactive_shop" };

  // shopId always comes from our database, never from the payload.
  const { job: saved, deduplicated } =
    job.type === "ORDER_SYNC"
      ? await enqueueJob({ shopId: shop.id, type: "ORDER_SYNC", payload: job.payload, dedupeKey: job.dedupeKey })
      : await enqueueJob({ shopId: shop.id, type: "CATALOG_SYNC", payload: job.payload, dedupeKey: job.dedupeKey });
  return { status: "enqueued", jobId: saved.id, deduplicated, jobType: job.type };
}

/** Context returned by authenticate.webhook() that this endpoint relies on. */
export interface AuthenticatedWebhook {
  topic: string;
  shop: string;
  payload: unknown;
  session?: unknown;
}

/**
 * HTTP contract of /webhooks/marginpilot. `authenticate` is the official
 * authenticate.webhook (it throws a 4xx Response on an invalid signature).
 * 200 only after the job is persisted; invalid payload 422; persistence failure 503.
 */
export async function handleShopifyWebhook(
  request: Request,
  authenticate: (request: Request) => Promise<AuthenticatedWebhook>,
  dispatch: typeof dispatchShopifyWebhook = dispatchShopifyWebhook,
): Promise<Response> {
  // Copy of the raw body, read only AFTER the official signature check below.
  const rawCopy = request.clone();
  const { topic, shop, payload, session } = await authenticate(request);
  const log = (fields: Record<string, unknown>) =>
    console.log(`[webhook] ${JSON.stringify({ topic: normalizeTopic(topic), shop, ...fields })}`);

  try {
    // REFUNDS_CREATE: order_id can exceed Number.MAX_SAFE_INTEGER; read its exact digits.
    let rawOrderId: string | undefined;
    if (normalizeTopic(topic) === "REFUNDS_CREATE") {
      try {
        rawOrderId = topLevelSourceOf(await rawCopy.text(), "order_id");
      } catch {
        throw new WebhookPayloadError("REFUNDS_CREATE: raw body is not valid JSON");
      }
    }
    const result = await dispatch({ topic, shopDomain: shop, payload, hasSession: Boolean(session), rawOrderId });
    if (result.status === "enqueued") {
      log({ result: result.deduplicated ? "deduplicated" : "enqueued", jobId: result.jobId, jobType: result.jobType });
    } else {
      log({ result: "ignored", reason: result.reason });
    }
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof WebhookPayloadError) {
      log({ result: "rejected", error: "invalid_payload", message: error.message });
      return new Response("Invalid webhook payload", { status: 422 });
    }
    // Never expose internal (PostgreSQL) messages; Shopify retries on 5xx.
    log({ result: "failed", error: "persistence" });
    return new Response("Temporarily unavailable", { status: 503 });
  }
}
