import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import prisma from "../../db.server.ts";
import { processJobsOnce } from "../job-queue.server.ts";
import {
  CATALOG_DEDUPE_KEY,
  dispatchShopifyWebhook,
  handleShopifyWebhook,
  routeWebhook,
  topLevelSourceOf,
  WebhookPayloadError,
} from "../shopify-webhook-dispatch.server.ts";
import type { AuthenticatedWebhook } from "../shopify-webhook-dispatch.server.ts";

// Real PostgreSQL (DATABASE_URL). Authentication is mocked only for the HTTP
// contract tests; the real authenticate.webhook is covered in shopify-webhook-route.test.ts.

const createdShopIds: string[] = [];
const ORDER = "gid://shopify/Order/8238342537543";
/** Above Number.MAX_SAFE_INTEGER: such an id was already rounded by JSON.parse. */
const UNSAFE_ID = 2 ** 60;

async function createShop(overrides: { isActive?: boolean; uninstalledAt?: Date } = {}) {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: {
      shopifyGid: `gid://shopify/Shop/test-${suffix}`,
      myshopifyDomain: `pg010-${suffix}.myshopify.com`,
      name: "PG-010 test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: false,
      installedAt: new Date("2026-10-20T00:00:00Z"),
      ...overrides,
    },
  });
  createdShopIds.push(shop.id);
  return shop;
}

const dispatch = (shopDomain: string, topic: string, payload: unknown, hasSession = true) =>
  dispatchShopifyWebhook({ topic, shopDomain, payload, hasSession });
const jobsOf = (shopId: string) => prisma.job.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } });
const orderPayload = (gid = ORDER) => ({ id: 8238342537543, admin_graphql_api_id: gid, email: "client@example.com" });

afterEach(async () => {
  await prisma.job.deleteMany({ where: { shopId: { in: createdShopIds } } });
});

after(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe("routeWebhook (pure mapping)", () => {
  it("1/2. orders/create and orders/updated give ORDER_SYNC on the order GID", () => {
    for (const topic of ["orders/create", "ORDERS_UPDATED"]) {
      assert.deepEqual(routeWebhook(topic, orderPayload()), {
        type: "ORDER_SYNC",
        payload: { orderGid: ORDER },
        dedupeKey: ORDER,
      });
    }
  });

  it("3/4. refunds/create syncs the PARENT order, not the refund id", () => {
    const routed = routeWebhook("refunds/create", {
      id: 1148460925255,
      order_id: 8238342537543,
      admin_graphql_api_id: "gid://shopify/Refund/1148460925255",
    });
    assert.deepEqual(routed, { type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER });
    // A decimal string id is accepted as is.
    assert.equal(
      routeWebhook("REFUNDS_CREATE", { order_id: "820982911946154508" }).dedupeKey,
      "gid://shopify/Order/820982911946154508",
    );
  });

  it("5. unsafe or malformed refund order_id is rejected, never rounded", () => {
    for (const orderId of [UNSAFE_ID, 12.5, -1, 0, Number.NaN, "12a", "", null, undefined]) {
      assert.throws(() => routeWebhook("refunds/create", { order_id: orderId }), WebhookPayloadError, String(orderId));
    }
  });

  it("6/7. product and inventory events give CATALOG_SYNC with one shared key", () => {
    for (const topic of ["products/create", "products/update", "products/delete", "inventory_items/update"]) {
      assert.deepEqual(routeWebhook(topic, { id: 1 }), { type: "CATALOG_SYNC", payload: {}, dedupeKey: CATALOG_DEDUPE_KEY });
    }
  });

  it("14. invalid payloads and unknown topics are rejected", () => {
    assert.throws(() => routeWebhook("orders/create", { admin_graphql_api_id: "gid://shopify/Refund/1" }), WebhookPayloadError);
    assert.throws(() => routeWebhook("orders/create", null), WebhookPayloadError);
    assert.throws(() => routeWebhook("products/update", [1]), WebhookPayloadError);
    assert.throws(() => routeWebhook("customers/create", {}), WebhookPayloadError);
  });
});

describe("topLevelSourceOf / exact refund order_id", () => {
  it("returns the exact source digits of a top-level number only", () => {
    const raw = '{"order_adjustments":[{"order_id":1}],"order_id":820982911946154508}';
    assert.equal(topLevelSourceOf(raw, "order_id"), "820982911946154508");
    assert.equal(topLevelSourceOf('{"x":{"order_id":5}}', "order_id"), undefined);
    assert.equal(topLevelSourceOf('{"order_id":"123"}', "order_id"), '"123"');
  });

  it("routes with the raw digits, never with the rounded number or the refund GID", () => {
    const payload = JSON.parse('{"order_id":820982911946154508,"admin_graphql_api_id":"gid://shopify/Refund/9"}');
    const routed = routeWebhook("refunds/create", payload, "820982911946154508");
    assert.equal(routed.dedupeKey, "gid://shopify/Order/820982911946154508");
    // Malformed raw sources stay rejected.
    for (const raw of ["8.2e17", "-1", "1.5", "0", '"12"']) {
      assert.throws(() => routeWebhook("refunds/create", { order_id: 1 }, raw), WebhookPayloadError, raw);
    }
    // A JSON string id keeps working without raw source.
    assert.equal(routeWebhook("refunds/create", { order_id: "42" }).dedupeKey, "gid://shopify/Order/42");
  });
});

describe("dispatchShopifyWebhook (PostgreSQL)", () => {
  it("1/2/3. order events enqueue ORDER_SYNC with only { orderGid }, no PII copied", async () => {
    const shop = await createShop();
    const result = await dispatch(shop.myshopifyDomain, "orders/create", orderPayload());
    assert.equal(result.status, "enqueued");
    const [job] = await jobsOf(shop.id);
    assert.equal(job.type, "ORDER_SYNC");
    assert.deepEqual(job.payload, { orderGid: ORDER });
    assert.equal(job.dedupeKey, ORDER);
    assert.equal(job.shopId, shop.id);
  });

  it("8. several events on one order: a single PENDING job", async () => {
    const shop = await createShop();
    const results = [
      await dispatch(shop.myshopifyDomain, "orders/create", orderPayload()),
      await dispatch(shop.myshopifyDomain, "orders/updated", orderPayload()),
      await dispatch(shop.myshopifyDomain, "refunds/create", { order_id: 8238342537543 }),
      await dispatch(shop.myshopifyDomain, "orders/updated", orderPayload()),
    ];
    assert.deepEqual(results.map((r) => r.status === "enqueued" && r.deduplicated), [false, true, true, true]);
    assert.equal((await jobsOf(shop.id)).length, 1);
    // Another order is a separate job.
    await dispatch(shop.myshopifyDomain, "orders/create", orderPayload("gid://shopify/Order/2"));
    assert.equal((await jobsOf(shop.id)).length, 2);
  });

  it("9. several catalog events: a single PENDING CATALOG_SYNC", async () => {
    const shop = await createShop();
    for (const topic of ["products/create", "products/update", "inventory_items/update", "products/delete"]) {
      await dispatch(shop.myshopifyDomain, topic, { id: 1 });
    }
    const jobs = await jobsOf(shop.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, "CATALOG_SYNC");
    assert.deepEqual(jobs[0].payload, {});
  });

  it("10. an event while the job is RUNNING creates a new PENDING job", async () => {
    const shop = await createShop();
    await dispatch(shop.myshopifyDomain, "orders/create", orderPayload());
    let during: Awaited<ReturnType<typeof dispatch>> | undefined;
    await processJobsOnce({
      limit: 1,
      execute: async () => {
        during = await dispatch(shop.myshopifyDomain, "orders/updated", orderPayload());
      },
    });
    assert.equal(during?.status === "enqueued" && during.deduplicated, false);
    const jobs = await jobsOf(shop.id);
    assert.deepEqual(jobs.map((job) => job.status), ["SUCCEEDED", "PENDING"]);
  });

  it("11. shops A and B are isolated by their own domain", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    await dispatch(shopA.myshopifyDomain, "orders/create", orderPayload());
    await dispatch(shopB.myshopifyDomain, "orders/create", { ...orderPayload(), shop_id: shopA.id });
    assert.equal((await jobsOf(shopA.id)).length, 1);
    assert.equal((await jobsOf(shopB.id)).length, 1, "payload shop_id is ignored");
  });

  it("12/13. unknown shop, inactive shop or missing session: no job", async () => {
    const inactive = await createShop({ isActive: false });
    const uninstalled = await createShop({ uninstalledAt: new Date("2026-10-20T01:00:00Z") });
    const active = await createShop();
    assert.deepEqual(await dispatch("unknown.myshopify.com", "orders/create", orderPayload()), {
      status: "ignored", reason: "unknown_shop",
    });
    assert.deepEqual(await dispatch(inactive.myshopifyDomain, "orders/create", orderPayload()), {
      status: "ignored", reason: "inactive_shop",
    });
    assert.deepEqual(await dispatch(uninstalled.myshopifyDomain, "orders/create", orderPayload()), {
      status: "ignored", reason: "inactive_shop",
    });
    assert.deepEqual(await dispatch(active.myshopifyDomain, "orders/create", orderPayload(), false), {
      status: "ignored", reason: "no_session",
    });
    assert.equal(await prisma.job.count({ where: { shopId: { in: [inactive.id, uninstalled.id, active.id] } } }), 0);
  });

  it("14. an invalid payload creates no job", async () => {
    const shop = await createShop();
    await assert.rejects(dispatch(shop.myshopifyDomain, "refunds/create", { order_id: 1.5 }), WebhookPayloadError);
    assert.equal((await jobsOf(shop.id)).length, 0);
  });
});

describe("handleShopifyWebhook (HTTP contract)", () => {
  const request = () => new Request("https://app.test/webhooks/marginpilot", { method: "POST", body: "{}" });
  const authAs = (context: AuthenticatedWebhook) => async () => context;

  it("200 only after the job is persisted; 200 again when deduplicated", async () => {
    const shop = await createShop();
    const context = { topic: "ORDERS_CREATE", shop: shop.myshopifyDomain, payload: orderPayload(), session: {} };
    const first = await handleShopifyWebhook(request(), authAs(context));
    assert.equal(first.status, 200);
    assert.equal((await jobsOf(shop.id)).length, 1);
    assert.equal((await handleShopifyWebhook(request(), authAs(context))).status, 200);
    assert.equal((await jobsOf(shop.id)).length, 1);
  });

  it("12/13. unknown shop or uninstalled app (no session): 200 without job", async () => {
    const shop = await createShop();
    const unknown = await handleShopifyWebhook(
      request(),
      authAs({ topic: "ORDERS_CREATE", shop: "nope.myshopify.com", payload: orderPayload(), session: {} }),
    );
    const noSession = await handleShopifyWebhook(
      request(),
      authAs({ topic: "ORDERS_CREATE", shop: shop.myshopifyDomain, payload: orderPayload(), session: undefined }),
    );
    assert.equal(unknown.status, 200);
    assert.equal(noSession.status, 200);
    assert.equal((await jobsOf(shop.id)).length, 0);
  });

  it("14. invalid payload: 422, no job", async () => {
    const shop = await createShop();
    const response = await handleShopifyWebhook(
      request(),
      authAs({ topic: "REFUNDS_CREATE", shop: shop.myshopifyDomain, payload: { order_id: UNSAFE_ID }, session: {} }),
    );
    assert.equal(response.status, 422);
    assert.equal((await jobsOf(shop.id)).length, 0);
  });

  it("15. persistence failure: 503 without internal details, never a false 200", async () => {
    const shop = await createShop();
    const response = await handleShopifyWebhook(
      request(),
      authAs({ topic: "ORDERS_CREATE", shop: shop.myshopifyDomain, payload: orderPayload(), session: {} }),
      async () => {
        throw new Error('relation "Job" does not exist (PostgreSQL internal detail)');
      },
    );
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("PostgreSQL"));
    assert.equal((await jobsOf(shop.id)).length, 0);
  });

  it("16. the handler makes no GraphQL call", async () => {
    const shop = await createShop();
    let graphqlCalls = 0;
    const admin = { graphql: async () => { graphqlCalls += 1; return Response.json({}); } };
    const context = { topic: "PRODUCTS_UPDATE", shop: shop.myshopifyDomain, payload: { id: 1 }, session: {}, admin };
    const response = await handleShopifyWebhook(request(), authAs(context));
    assert.equal(response.status, 200);
    assert.equal(graphqlCalls, 0);
  });

  it("an authentication failure is the SDK response, untouched", async () => {
    const rejected = new Response(null, { status: 401 });
    await assert.rejects(
      handleShopifyWebhook(request(), async () => { throw rejected; }),
      (error: unknown) => error === rejected,
    );
  });
});

describe("configuration", () => {
  it("17. shopify.app.toml keeps existing webhooks and subscribes each topic once", () => {
    const toml = readFileSync(new URL("../../../shopify.app.toml", import.meta.url), "utf8");
    const topics = [...toml.matchAll(/"([a-z_]+\/[a-z_]+)"/g)].map((match) => match[1]);
    for (const topic of [
      "app/uninstalled", "app/scopes_update", "orders/create", "orders/updated", "refunds/create",
      "products/create", "products/update", "products/delete", "inventory_items/update",
    ]) {
      assert.equal(topics.filter((candidate) => candidate === topic).length, 1, topic);
    }
    assert.match(toml, /uri = "\/webhooks\/app\/uninstalled"/);
    assert.match(toml, /uri = "\/webhooks\/app\/scopes_update"/);
    assert.match(toml, /uri = "\/webhooks\/marginpilot"/);
  });
});
