import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import prisma from "../../db.server.ts";
import { Decimal } from "../../domain/profit-engine/money.ts";
import { reconcileShopifyOrders, ReconciliationError } from "../shopify-order-reconciliation.server.ts";
import { OrderSyncError } from "../shopify-order-sync.server.ts";
import type { AdminGraphqlClient } from "../shopify-catalog-sync.server.ts";

// Deterministic fake Shopify GraphQL + real PostgreSQL (DATABASE_URL).
// Fixtures live in dedicated shops; `after` deletes only those shops.

type Json = Record<string, unknown>;
const bag = (amount: string) => ({ shopMoney: { amount, currencyCode: "EUR" } });
const connection = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const gid = (n: number) => `gid://shopify/Order/${n}`;
const since = new Date("2026-10-19T09:00:00.000Z");
const until = new Date("2026-10-19T10:00:00.000Z");

function shopifyOrder(n: number, updatedAt = "2026-10-19T09:30:00Z", overrides: Json = {}): Json {
  const zero = bag("0.0");
  return {
    id: gid(n), name: `#${n}`, number: n, test: false,
    createdAt: "2026-10-19T08:00:00Z", updatedAt, processedAt: "2026-10-19T08:00:00Z",
    cancelledAt: null, cancelReason: null, currencyCode: "EUR", presentmentCurrencyCode: "EUR",
    taxesIncluded: false, dutiesIncluded: false, displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED", totalWeight: null, customer: null,
    subtotalPriceSet: bag("100.0"), totalPriceSet: bag("100.0"), currentTotalPriceSet: bag("100.0"),
    totalDiscountsSet: zero, currentTotalDiscountsSet: zero, totalTaxSet: zero, currentTotalTaxSet: zero,
    currentShippingPriceSet: zero, totalTipReceivedSet: zero, originalTotalDutiesSet: null,
    currentTotalDutiesSet: null, originalTotalAdditionalFeesSet: null, currentTotalAdditionalFeesSet: null,
    totalReceivedSet: bag("100.0"), netPaymentSet: bag("100.0"), totalRefundedSet: zero,
    totalRefundedShippingSet: zero, totalOutstandingSet: zero,
    shippingLines: connection([]),
    lineItems: connection([
      {
        id: `gid://shopify/LineItem/${n}`, title: "Snowboard", variantTitle: null, sku: null,
        quantity: 1, currentQuantity: 1, refundableQuantity: 1, isGiftCard: false,
        product: { id: "gid://shopify/Product/1" },
        variant: { id: "gid://shopify/ProductVariant/1", inventoryItem: { id: "gid://shopify/InventoryItem/1" } },
        originalUnitPriceSet: bag("100.0"), originalTotalSet: bag("100.0"), discountAllocations: [], taxLines: [],
      },
    ]),
    transactions: [],
    refunds: [],
    ...overrides,
  };
}

/**
 * pages: the GID lists Shopify returns page by page for the window.
 * orders: the order details by GID (null = Shopify returns order: null).
 */
function fakeAdmin(
  pages: unknown[][],
  orders: Record<string, Json | null>,
  options: { failAtPage?: number; pageInfo?: unknown } = {},
): AdminGraphqlClient & { searches: Json[]; details: string[] } {
  const searches: Json[] = [];
  const details: string[] = [];
  return {
    searches,
    details,
    async graphql(query, { variables = {} } = {}) {
      if (query.includes("OrderReconciliationPage")) {
        const index = variables.cursor ? Number.parseInt(String(variables.cursor).slice(2), 10) : 0;
        searches.push({ query, variables });
        if (options.failAtPage === index) return Response.json({ errors: [{ message: "Throttled" }] });
        const hasNextPage = index + 1 < pages.length;
        return Response.json({
          data: {
            orders: {
              pageInfo: "pageInfo" in options ? options.pageInfo : { hasNextPage, endCursor: hasNextPage ? `c:${index + 1}` : null },
              nodes: (pages[index] ?? []).map((id) => ({ id, updatedAt: "2026-10-19T09:30:00Z" })),
            },
          },
        });
      }
      if (query.includes("OrderImportDetail")) {
        details.push(String(variables.id));
        return Response.json({ data: { order: orders[String(variables.id)] ?? null } });
      }
      throw new Error(`unexpected query ${query}`);
    },
  };
}

const createdShopIds: string[] = [];

async function createShop(): Promise<string> {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: {
      shopifyGid: `gid://shopify/Shop/test-${suffix}`,
      myshopifyDomain: `pg008-${suffix}.myshopify.com`,
      name: "PG-008 test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: false,
      installedAt: new Date("2026-10-19T00:00:00Z"),
    },
  });
  createdShopIds.push(shop.id);
  return shop.id;
}

async function createCatalog(shopId: string, unitCost: string) {
  const at = new Date("2026-10-19T00:00:00Z");
  const item = await prisma.inventoryItem.create({
    data: {
      shopId, shopifyGid: "gid://shopify/InventoryItem/1", unitCost: new Decimal(unitCost),
      unitCostCurrencyCode: "EUR", shopifyUpdatedAt: at,
    },
  });
  const product = await prisma.product.create({
    data: { shopId, shopifyGid: "gid://shopify/Product/1", title: "P", status: "ACTIVE", shopifyCreatedAt: at, shopifyUpdatedAt: at },
  });
  await prisma.productVariant.create({
    data: {
      shopId, productId: product.id, inventoryItemId: item.id, shopifyGid: "gid://shopify/ProductVariant/1",
      title: "Default", price: new Decimal(100), priceCurrencyCode: "EUR",
    },
  });
  return item;
}

const run = (shopId: string, admin: AdminGraphqlClient, window = { updatedSince: since, updatedUntil: until }) =>
  reconcileShopifyOrders({ shopId, admin, ...window });

after(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe("reconcileShopifyOrders", () => {
  it("1. empty window: all counters at 0", async () => {
    const shopId = await createShop();
    const result = await run(shopId, fakeAdmin([[]], {}));
    assert.deepEqual(result, { discovered: 0, synced: 0, skippedStale: 0, snapshotsCreated: 0 });
  });

  it("2/8/9. one order: synced, with the exact updated_at bounds and UPDATED_AT sort", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1) });
    const result = await run(shopId, admin);
    assert.deepEqual(result, { discovered: 1, synced: 1, skippedStale: 0, snapshotsCreated: 1 });

    const [search] = admin.searches;
    assert.equal(
      (search.variables as Json).query,
      "updated_at:>='2026-10-19T09:00:00.000Z' updated_at:<'2026-10-19T10:00:00.000Z'",
    );
    assert.match(String(search.query), /sortKey: UPDATED_AT/);
    assert.match(String(search.query), /first: 100/);
    assert.equal(await prisma.order.count({ where: { shopId } }), 1);
  });

  it("3/4/5. several orders over several pages; repeated GIDs synced once", async () => {
    const shopId = await createShop();
    const orders = Object.fromEntries([1, 2, 3, 4].map((n) => [gid(n), shopifyOrder(n)]));
    // 6 raw nodes, 4 unique GIDs (2 and 3 appear twice across pages).
    const admin = fakeAdmin([[gid(1), gid(2)], [gid(2), gid(3)], [gid(3), gid(4)]], orders);
    const result = await run(shopId, admin);
    assert.equal(admin.searches.length, 3);
    assert.deepEqual(result, { discovered: 4, synced: 4, skippedStale: 0, snapshotsCreated: 4 });
    assert.deepEqual(admin.details, [gid(1), gid(2), gid(3), gid(4)]);
    assert.equal(await prisma.order.count({ where: { shopId } }), 4);
  });

  it("6/7. invalid windows are rejected before any Shopify call", async () => {
    const shopId = await createShop();
    const windows = [
      { updatedSince: new Date("not a date"), updatedUntil: until },
      { updatedSince: since, updatedUntil: new Date(Number.NaN) },
      { updatedSince: "2026-10-19" as unknown as Date, updatedUntil: until },
      { updatedSince: until, updatedUntil: since },
      { updatedSince: since, updatedUntil: since },
    ];
    for (const window of windows) {
      const admin = fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1) });
      await assert.rejects(
        run(shopId, admin, window),
        (error: unknown) => error instanceof ReconciliationError && error.code === "INVALID_WINDOW",
      );
      assert.equal(admin.searches.length, 0);
    }
  });

  it("10/12/15. replaying the window is idempotent: no duplicate, snapshot unchanged", async () => {
    const shopId = await createShop();
    const item = await createCatalog(shopId, "40");
    const orders = { [gid(1)]: shopifyOrder(1), [gid(2)]: shopifyOrder(2) };
    await run(shopId, fakeAdmin([[gid(1), gid(2)]], orders));
    const snapshotsBefore = await prisma.orderLineCostSnapshot.findMany({ where: { shopId }, orderBy: { id: "asc" } });

    await prisma.inventoryItem.update({ where: { id: item.id }, data: { unitCost: new Decimal(50) } });
    const replay = await run(shopId, fakeAdmin([[gid(1), gid(2)]], orders));
    assert.deepEqual(replay, { discovered: 2, synced: 2, skippedStale: 0, snapshotsCreated: 0 });

    assert.equal(await prisma.order.count({ where: { shopId } }), 2);
    assert.equal(await prisma.orderLine.count({ where: { shopId } }), 2);
    const snapshotsAfter = await prisma.orderLineCostSnapshot.findMany({ where: { shopId }, orderBy: { id: "asc" } });
    assert.deepEqual(snapshotsAfter, snapshotsBefore);
    assert.ok(snapshotsAfter.every((snapshot) => snapshot.unitCost?.toString() === "40"));
  });

  it("11. a newer local order is counted as skippedStale", async () => {
    const shopId = await createShop();
    await run(shopId, fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1, "2026-10-19T09:50:00Z") }));
    const result = await run(shopId, fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1, "2026-10-19T09:10:00Z", { name: "#old" }) }));
    assert.deepEqual(result, { discovered: 1, synced: 0, skippedStale: 1, snapshotsCreated: 0 });
    const order = await prisma.order.findFirstOrThrow({ where: { shopId } });
    assert.equal(order.name, "#1");
  });

  it("13. a Shopify error on a search page fails the run, before any sync", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([[gid(1)], [gid(2)]], { [gid(1)]: shopifyOrder(1), [gid(2)]: shopifyOrder(2) }, { failAtPage: 1 });
    await assert.rejects(
      run(shopId, admin),
      (error: unknown) => error instanceof ReconciliationError && error.code === "SHOPIFY_GRAPHQL_ERROR",
    );
    assert.deepEqual(admin.details, []);
    assert.equal(await prisma.order.count({ where: { shopId } }), 0);
  });

  it("14. a PG-007 error stops the run; earlier orders stay synced", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([[gid(1), gid(2), gid(3)]], {
      [gid(1)]: shopifyOrder(1),
      [gid(2)]: null, // ORDER_NOT_FOUND
      [gid(3)]: shopifyOrder(3),
    });
    await assert.rejects(
      run(shopId, admin),
      (error: unknown) => error instanceof OrderSyncError && error.code === "ORDER_NOT_FOUND",
    );
    assert.deepEqual(admin.details, [gid(1), gid(2)], "order 3 is never reached");
    const gids = (await prisma.order.findMany({ where: { shopId }, select: { shopifyGid: true } })).map((o) => o.shopifyGid);
    assert.deepEqual(gids, [gid(1)]);
  });

  it("14b. invalid order data from PG-007 also stops the run", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1, "2026-10-19T09:30:00Z", { totalPriceSet: bag("1.1234567") }) });
    await assert.rejects(
      run(shopId, admin),
      (error: unknown) => error instanceof OrderSyncError && error.code === "INVALID_MONEY",
    );
    assert.equal(await prisma.order.count({ where: { shopId } }), 0);
  });

  it("16. shop A and shop B stay isolated", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    await run(shopA, fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1) }));
    await run(shopB, fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1, "2026-10-19T09:30:00Z", { name: "#B" }) }));
    const orderA = await prisma.order.findFirstOrThrow({ where: { shopId: shopA } });
    const orderB = await prisma.order.findFirstOrThrow({ where: { shopId: shopB } });
    assert.notEqual(orderA.id, orderB.id);
    assert.equal(orderA.name, "#1");
    assert.equal(orderB.name, "#B");
  });

  it("17. hasNextPage=true without endCursor fails the run", async () => {
    const shopId = await createShop();
    for (const pageInfo of [{ hasNextPage: true, endCursor: null }, { endCursor: null }, null]) {
      const admin = fakeAdmin([[gid(1)]], { [gid(1)]: shopifyOrder(1) }, { pageInfo });
      await assert.rejects(
        run(shopId, admin),
        (error: unknown) => error instanceof ReconciliationError && error.code === "INVALID_SHOPIFY_DATA",
      );
      assert.deepEqual(admin.details, []);
    }
    assert.equal(await prisma.order.count({ where: { shopId } }), 0);
  });

  it("unknown shop is rejected before any Shopify call", async () => {
    const admin = fakeAdmin([[]], {});
    await assert.rejects(
      run(randomUUID(), admin),
      (error: unknown) => error instanceof ReconciliationError && error.code === "SHOP_NOT_FOUND",
    );
    assert.equal(admin.searches.length, 0);
  });
});
