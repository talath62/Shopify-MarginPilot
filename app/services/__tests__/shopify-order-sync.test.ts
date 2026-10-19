import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import prisma from "../../db.server.ts";
import { Decimal } from "../../domain/profit-engine/money.ts";
import { OrderSyncError, syncShopifyOrderByGid } from "../shopify-order-sync.server.ts";
import type { AdminGraphqlClient } from "../shopify-catalog-sync.server.ts";

// Deterministic fake Shopify GraphQL + real PostgreSQL (DATABASE_URL).
// Fixtures live in dedicated shops; `after` deletes only those shops.

type Json = Record<string, unknown>;
const bag = (amount: string) => ({ shopMoney: { amount, currencyCode: "EUR" } });
const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
const ORDER_GID = "gid://shopify/Order/5001";

function lineItem(key: string): Json {
  return {
    id: `gid://shopify/LineItem/${key}`,
    title: `Line ${key}`,
    variantTitle: null,
    sku: null,
    quantity: 1,
    currentQuantity: 1,
    refundableQuantity: 1,
    isGiftCard: false,
    product: { id: `gid://shopify/Product/${key}` },
    variant: { id: `gid://shopify/ProductVariant/${key}`, inventoryItem: { id: `gid://shopify/InventoryItem/${key}` } },
    originalUnitPriceSet: bag("100.0"),
    originalTotalSet: bag("100.0"),
    discountAllocations: [],
    taxLines: [],
  };
}

function shopifyOrder(updatedAt: string, overrides: Json = {}): Json {
  const zero = bag("0.0");
  return {
    id: ORDER_GID, name: "#5001", number: 5001, test: false,
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
    shippingLines: page([]),
    lineItems: page([lineItem("A")]),
    transactions: [
      {
        id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments",
        formattedGateway: "Shopify Payments", test: false, errorCode: null, processedAt: updatedAt, createdAt: updatedAt,
        amountSet: bag("100.0"), settlementCurrency: null, settlementCurrencyRate: null, parentTransaction: null,
        fees: [{ type: "processing_fee", flatFeeName: null, rateName: null, rate: "0.027",
          amount: { amount: "2.95", currencyCode: "EUR" }, flatFee: null, taxAmount: null }],
      },
    ],
    refunds: [],
    ...overrides,
  };
}

/** Returns whatever `state.order` currently holds, like Shopify after a change. */
function fakeAdmin(state: { order: Json | null }): AdminGraphqlClient & { calls: number } {
  const admin = {
    calls: 0,
    async graphql(query: string, { variables = {} }: { variables?: Record<string, unknown> } = {}) {
      admin.calls += 1;
      if (!query.includes("OrderImportDetail")) throw new Error(`unexpected query ${query}`);
      const order = state.order && state.order.id === variables.id ? state.order : null;
      return Response.json({ data: { order } });
    },
  };
  return admin;
}

const createdShopIds: string[] = [];

async function createShop(): Promise<string> {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: {
      shopifyGid: `gid://shopify/Shop/test-${suffix}`,
      myshopifyDomain: `pg007-${suffix}.myshopify.com`,
      name: "PG-007 test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: false,
      installedAt: new Date("2026-10-19T00:00:00Z"),
    },
  });
  createdShopIds.push(shop.id);
  return shop.id;
}

async function createCatalog(shopId: string, key: string, unitCost: string | null) {
  const at = new Date("2026-10-19T00:00:00Z");
  const item = await prisma.inventoryItem.create({
    data: {
      shopId, shopifyGid: `gid://shopify/InventoryItem/${key}`,
      unitCost: unitCost === null ? null : new Decimal(unitCost),
      unitCostCurrencyCode: unitCost === null ? null : "EUR", shopifyUpdatedAt: at,
    },
  });
  const product = await prisma.product.create({
    data: { shopId, shopifyGid: `gid://shopify/Product/${key}`, title: key, status: "ACTIVE", shopifyCreatedAt: at, shopifyUpdatedAt: at },
  });
  await prisma.productVariant.create({
    data: {
      shopId, productId: product.id, inventoryItemId: item.id, shopifyGid: `gid://shopify/ProductVariant/${key}`,
      title: "Default", price: new Decimal(100), priceCurrencyCode: "EUR",
    },
  });
  return item;
}

const loadOrder = (shopId: string) =>
  prisma.order.findUniqueOrThrow({
    where: { shopId_shopifyGid: { shopId, shopifyGid: ORDER_GID } },
    include: {
      lines: { orderBy: { shopifyGid: "asc" }, include: { costSnapshot: true } },
      transactions: { include: { fees: true } },
      refunds: { include: { lines: true, adjustments: true } },
    },
  });

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof OrderSyncError && error.code === code);

after(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe("syncShopifyOrderByGid", () => {
  it("1/7/9. syncs a new order with a known-cost snapshot, not historical", async () => {
    const shopId = await createShop();
    await createCatalog(shopId, "A", "40");
    const result = await syncShopifyOrderByGid({
      shopId, admin: fakeAdmin({ order: shopifyOrder("2026-10-19T09:00:00Z") }), orderGid: ORDER_GID,
    });

    const order = await loadOrder(shopId);
    assert.deepEqual(result, { status: "synced", orderId: order.id, orderGid: ORDER_GID, orderLines: 1, snapshotsCreated: 1 });
    const snapshot = order.lines[0].costSnapshot;
    assert.equal(snapshot?.source, "SHOPIFY_UNIT_COST");
    assert.equal(snapshot?.unitCost?.toString(), "40");
    assert.equal(snapshot?.historicalApproximation, false);
  });

  it("8. unknown cost: MISSING snapshot, not historical", async () => {
    const shopId = await createShop();
    await syncShopifyOrderByGid({ shopId, admin: fakeAdmin({ order: shopifyOrder("2026-10-19T09:00:00Z") }), orderGid: ORDER_GID });
    const snapshot = (await loadOrder(shopId)).lines[0].costSnapshot;
    assert.equal(snapshot?.source, "MISSING");
    assert.equal(snapshot?.unitCost, null);
    assert.equal(snapshot?.currencyCode, null);
    assert.equal(snapshot?.historicalApproximation, false);
  });

  it("2-6. updates the order: no duplicates, children refreshed, new line snapshotted, old snapshot kept", async () => {
    const shopId = await createShop();
    const itemA = await createCatalog(shopId, "A", "40");
    await createCatalog(shopId, "B", "15");
    const state = { order: shopifyOrder("2026-10-19T09:00:00Z") as Json | null };
    const admin = fakeAdmin(state);
    await syncShopifyOrderByGid({ shopId, admin, orderGid: ORDER_GID });
    const first = await loadOrder(shopId);

    // Catalog cost changes, then Shopify adds line B, a refund and new fees.
    await prisma.inventoryItem.update({ where: { id: itemA.id }, data: { unitCost: new Decimal(50) } });
    state.order = shopifyOrder("2026-10-19T10:00:00Z", {
      displayFinancialStatus: "PARTIALLY_REFUNDED",
      lineItems: page([lineItem("A"), lineItem("B")]),
      transactions: [
        { ...(shopifyOrder("2026-10-19T10:00:00Z").transactions as Json[])[0], fees: [
          { type: "processing_fee", flatFeeName: null, rateName: null, rate: "0.03",
            amount: { amount: "3.25", currencyCode: "EUR" }, flatFee: null, taxAmount: null },
        ] },
        {
          id: "gid://shopify/OrderTransaction/2", kind: "REFUND", status: "SUCCESS", gateway: "shopify_store_credit",
          formattedGateway: "Shopify Store Credit", test: false, errorCode: null, processedAt: "2026-10-19T10:00:00Z",
          createdAt: "2026-10-19T10:00:00Z", amountSet: bag("100.0"), settlementCurrency: null,
          settlementCurrencyRate: null, parentTransaction: null, fees: [],
        },
      ],
      refunds: [
        {
          id: "gid://shopify/Refund/1", createdAt: "2026-10-19T10:00:00Z", updatedAt: "2026-10-19T10:00:00Z",
          totalRefundedSet: bag("100.0"),
          refundLineItems: page([{ id: null, quantity: 1, restockType: "CANCEL", restocked: true,
            lineItem: { id: "gid://shopify/LineItem/A" }, subtotalSet: bag("100.0"), totalTaxSet: bag("0.0") }]),
          refundShippingLines: page([]),
          orderAdjustments: page([{ reason: "REFUND_DISCREPANCY", amountSet: bag("-5.00"), taxAmountSet: bag("0.00") }]),
          transactions: page([{ id: "gid://shopify/OrderTransaction/2" }]),
        },
      ],
    });
    const result = await syncShopifyOrderByGid({ shopId, admin, orderGid: ORDER_GID });
    assert.equal(result.status, "synced");
    assert.equal(result.orderLines, 2);
    assert.equal(result.snapshotsCreated, 1);

    const second = await loadOrder(shopId);
    // 2/3. same order, no duplicates
    assert.equal(second.id, first.id);
    assert.equal(await prisma.order.count({ where: { shopId } }), 1);
    assert.equal(await prisma.orderTransaction.count({ where: { shopId } }), 2);
    assert.equal(second.displayFinancialStatus, "PARTIALLY_REFUNDED");
    // 4. financial children refreshed
    const sale = second.transactions.find((t) => t.kind === "SALE");
    assert.deepEqual(sale?.fees.map((fee) => fee.amount.toString()), ["3.25"]);
    assert.equal(await prisma.transactionFee.count({ where: { shopId } }), 1);
    const [refund] = second.refunds;
    assert.equal(refund.adjustments[0].amount.toString(), "-5");
    assert.equal(second.transactions.find((t) => t.kind === "REFUND")?.refundId, refund.id);
    // 5. line A kept (same id), its snapshot unchanged at 40
    assert.equal(second.lines[0].id, first.lines[0].id);
    assert.deepEqual(second.lines[0].costSnapshot, first.lines[0].costSnapshot);
    assert.equal(second.lines[0].costSnapshot?.unitCost?.toString(), "40");
    // 6. line B created with its own snapshot
    assert.equal(second.lines[1].shopifyGid, "gid://shopify/LineItem/B");
    assert.equal(second.lines[1].costSnapshot?.unitCost?.toString(), "15");
    assert.equal(second.lines[1].costSnapshot?.historicalApproximation, false);
  });

  it("10. older Shopify updatedAt: skipped_stale and nothing written", async () => {
    const shopId = await createShop();
    const state = { order: shopifyOrder("2026-10-19T10:00:00Z") as Json | null };
    await syncShopifyOrderByGid({ shopId, admin: fakeAdmin(state), orderGid: ORDER_GID });
    const before = await loadOrder(shopId);

    state.order = shopifyOrder("2026-10-19T09:00:00Z", {
      name: "#stale",
      lineItems: page([lineItem("A"), lineItem("B")]),
    });
    const result = await syncShopifyOrderByGid({ shopId, admin: fakeAdmin(state), orderGid: ORDER_GID });
    assert.deepEqual(result, { status: "skipped_stale", orderId: before.id, orderGid: ORDER_GID, orderLines: 0, snapshotsCreated: 0 });

    const afterSync = await loadOrder(shopId);
    assert.deepEqual(afterSync, before);
    assert.equal(await prisma.orderLine.count({ where: { shopId } }), 1);
    assert.equal(await prisma.orderLineCostSnapshot.count({ where: { shopId } }), 1);
  });

  it("concurrent syncs of the same order: the newest version wins, no duplicates", async () => {
    for (let round = 0; round < 6; round += 1) {
      const shopId = await createShop();
      const item = await createCatalog(shopId, "A", "40");
      const older = fakeAdmin({ order: shopifyOrder("2026-10-19T09:00:00Z", { name: "#old", lineItems: page([lineItem("A")]) }) });
      const newer = fakeAdmin({
        order: shopifyOrder("2026-10-19T10:00:00Z", { name: "#new", lineItems: page([lineItem("A"), lineItem("B")]) }),
      });
      const runOld = () => syncShopifyOrderByGid({ shopId, admin: older, orderGid: ORDER_GID });
      const runNew = () => syncShopifyOrderByGid({ shopId, admin: newer, orderGid: ORDER_GID });

      // Both orders of launch, including the first insert of the order.
      const results = await Promise.all(round % 2 === 0 ? [runOld(), runNew()] : [runNew(), runOld()]);
      const statuses = results.map((result) => result.status).sort();
      assert.ok(
        JSON.stringify(statuses) === JSON.stringify(["synced", "synced"]) ||
          JSON.stringify(statuses) === JSON.stringify(["skipped_stale", "synced"]),
      );

      const order = await loadOrder(shopId);
      assert.equal(order.shopifyUpdatedAt.toISOString(), "2026-10-19T10:00:00.000Z");
      assert.equal(order.name, "#new");
      assert.equal(await prisma.order.count({ where: { shopId } }), 1);
      assert.equal(await prisma.orderLine.count({ where: { shopId } }), 2);
      assert.equal(await prisma.orderLineCostSnapshot.count({ where: { shopId } }), 2);
      assert.equal(await prisma.orderTransaction.count({ where: { shopId } }), 1);

      // A later cost change never reaches the existing snapshots.
      const snapshotsBefore = await prisma.orderLineCostSnapshot.findMany({ where: { shopId }, orderBy: { id: "asc" } });
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { unitCost: new Decimal(50) } });
      await Promise.all([runOld(), runNew()]);
      const snapshotsAfter = await prisma.orderLineCostSnapshot.findMany({ where: { shopId }, orderBy: { id: "asc" } });
      assert.deepEqual(snapshotsAfter, snapshotsBefore);
      assert.equal((await loadOrder(shopId)).name, "#new");
    }
  });

  it("11. equal updatedAt: sync allowed", async () => {
    const shopId = await createShop();
    const state = { order: shopifyOrder("2026-10-19T10:00:00Z") as Json | null };
    await syncShopifyOrderByGid({ shopId, admin: fakeAdmin(state), orderGid: ORDER_GID });
    state.order = shopifyOrder("2026-10-19T10:00:00Z", { name: "#renamed" });
    const result = await syncShopifyOrderByGid({ shopId, admin: fakeAdmin(state), orderGid: ORDER_GID });
    assert.equal(result.status, "synced");
    assert.equal((await loadOrder(shopId)).name, "#renamed");
  });

  it("12. invalid order GID rejected before any call", async () => {
    const shopId = await createShop();
    for (const orderGid of ["123", "gid://shopify/Product/1", "gid://shopify/Order/abc", ""]) {
      const admin = fakeAdmin({ order: null });
      await rejectsWith(syncShopifyOrderByGid({ shopId, admin, orderGid }), "INVALID_ORDER_GID");
      assert.equal(admin.calls, 0);
    }
  });

  it("13. order null in Shopify: ORDER_NOT_FOUND, local order kept", async () => {
    const shopId = await createShop();
    await syncShopifyOrderByGid({ shopId, admin: fakeAdmin({ order: shopifyOrder("2026-10-19T09:00:00Z") }), orderGid: ORDER_GID });
    await rejectsWith(syncShopifyOrderByGid({ shopId, admin: fakeAdmin({ order: null }), orderGid: ORDER_GID }), "ORDER_NOT_FOUND");
    assert.equal(await prisma.order.count({ where: { shopId, deletedAt: null } }), 1);
  });

  it("14. shop A and shop B stay isolated", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    await createCatalog(shopB, "A", "12");
    await syncShopifyOrderByGid({ shopId: shopA, admin: fakeAdmin({ order: shopifyOrder("2026-10-19T09:00:00Z") }), orderGid: ORDER_GID });
    await syncShopifyOrderByGid({ shopId: shopB, admin: fakeAdmin({ order: shopifyOrder("2026-10-19T09:00:00Z") }), orderGid: ORDER_GID });

    const orderA = await loadOrder(shopA);
    const orderB = await loadOrder(shopB);
    assert.notEqual(orderA.id, orderB.id);
    assert.equal(orderA.lines[0].variantId, null);
    assert.equal(orderA.lines[0].costSnapshot?.source, "MISSING");
    assert.equal(orderB.lines[0].costSnapshot?.unitCost?.toString(), "12");
  });

  it("15. an error during persistence rolls the whole order back", async () => {
    const shopId = await createShop();
    const state = { order: shopifyOrder("2026-10-19T09:00:00Z") as Json | null };
    await syncShopifyOrderByGid({ shopId, admin: fakeAdmin(state), orderGid: ORDER_GID });
    const before = await loadOrder(shopId);

    // Newer data whose refund points to a transaction missing from order.transactions:
    // the check fails after the order and its lines were already upserted in the transaction.
    state.order = shopifyOrder("2026-10-19T11:00:00Z", {
      name: "#broken",
      lineItems: page([lineItem("A"), lineItem("B")]),
      refunds: [
        {
          id: "gid://shopify/Refund/9", createdAt: null, updatedAt: "2026-10-19T11:00:00Z", totalRefundedSet: bag("0.0"),
          refundLineItems: page([]), refundShippingLines: page([]), orderAdjustments: page([]),
          transactions: page([{ id: "gid://shopify/OrderTransaction/404" }]),
        },
      ],
    });
    await rejectsWith(syncShopifyOrderByGid({ shopId, admin: fakeAdmin(state), orderGid: ORDER_GID }), "INVALID_SHOPIFY_DATA");

    assert.deepEqual(await loadOrder(shopId), before);
    assert.equal(await prisma.orderLine.count({ where: { shopId } }), 1);
    assert.equal(await prisma.refund.count({ where: { shopId } }), 0);
  });

  it("unknown shop rejected", async () => {
    await rejectsWith(
      syncShopifyOrderByGid({ shopId: randomUUID(), admin: fakeAdmin({ order: null }), orderGid: ORDER_GID }),
      "SHOP_NOT_FOUND",
    );
  });

  it("invalid money is reported as an OrderSyncError", async () => {
    const shopId = await createShop();
    await rejectsWith(
      syncShopifyOrderByGid({
        shopId,
        admin: fakeAdmin({ order: shopifyOrder("2026-10-19T09:00:00Z", { totalPriceSet: bag("1.1234567") }) }),
        orderGid: ORDER_GID,
      }),
      "INVALID_MONEY",
    );
  });
});
