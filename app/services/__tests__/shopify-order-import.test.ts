import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import prisma from "../../db.server.ts";
import { Decimal } from "../../domain/profit-engine/money.ts";
import { importShopifyOrders, OrderImportError } from "../shopify-order-import.server.ts";
import type { AdminGraphqlClient } from "../shopify-catalog-sync.server.ts";

// Deterministic fake Shopify GraphQL + real PostgreSQL (DATABASE_URL).
// Fixtures live in dedicated shops; `after` deletes only those shops.

type Json = Record<string, unknown>;
const at = "2026-10-08T10:00:00Z";
const bag = (amount: string, currencyCode = "EUR") => ({ shopMoney: { amount, currencyCode } });
const page = (nodes: unknown[], endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
  nodes,
});

function lineItem(key: string, overrides: Json = {}): Json {
  return {
    id: `gid://shopify/LineItem/${key}`,
    title: `Line ${key}`,
    variantTitle: null,
    sku: `SKU-${key}`,
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
    ...overrides,
  };
}

function shopifyOrder(key: string, overrides: Json = {}): Json {
  return {
    id: `gid://shopify/Order/${key}`,
    name: `#${key}`,
    number: 1000,
    test: false,
    createdAt: at,
    updatedAt: at,
    processedAt: at,
    cancelledAt: null,
    cancelReason: null,
    currencyCode: "EUR",
    presentmentCurrencyCode: "EUR",
    taxesIncluded: false,
    dutiesIncluded: false,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    totalWeight: "1200",
    customer: { id: "gid://shopify/Customer/42" },
    subtotalPriceSet: bag("100.0"),
    totalPriceSet: bag("110.0"),
    currentTotalPriceSet: bag("110.0"),
    totalDiscountsSet: bag("0.0"),
    currentTotalDiscountsSet: bag("0.0"),
    totalTaxSet: bag("0.0"),
    currentTotalTaxSet: bag("0.0"),
    currentShippingPriceSet: bag("10.0"),
    totalTipReceivedSet: bag("0.0"),
    originalTotalDutiesSet: null,
    currentTotalDutiesSet: null,
    originalTotalAdditionalFeesSet: null,
    currentTotalAdditionalFeesSet: null,
    totalReceivedSet: bag("110.0"),
    netPaymentSet: bag("110.0"),
    totalRefundedSet: bag("0.0"),
    totalRefundedShippingSet: bag("0.0"),
    totalOutstandingSet: bag("0.0"),
    shippingLines: page([]),
    lineItems: page([lineItem(key)]),
    transactions: [],
    refunds: [],
    ...overrides,
  };
}

/** Serves order pages, order details and line-item pages like admin.graphql. */
function fakeAdmin(
  orders: Json[],
  options: {
    orderPageSize?: number;
    lineItemPageSize?: number;
    failDetailOf?: string;
  } = {},
): AdminGraphqlClient & { calls: string[] } {
  const orderPageSize = options.orderPageSize ?? 50;
  const lineItemPageSize = options.lineItemPageSize ?? 100;
  const calls: string[] = [];
  const allLines = (order: Json) => (order.lineItems as { nodes: Json[] }).nodes;
  const linePage = (order: Json, start: number) => {
    const lines = allLines(order);
    const nodes = lines.slice(start, start + lineItemPageSize);
    const end = start + nodes.length;
    return page(nodes, end < lines.length ? `l:${end}` : null);
  };

  return {
    calls,
    async graphql(query, { variables = {} } = {}) {
      if (query.includes("OrderImportPage")) {
        const start = variables.cursor ? Number.parseInt(String(variables.cursor).slice(2), 10) : 0;
        calls.push(`orders:${start}`);
        const nodes = orders.slice(start, start + orderPageSize).map((order) => ({ id: order.id }));
        const end = start + nodes.length;
        return Response.json({ data: { orders: page(nodes, end < orders.length ? `o:${end}` : null) } });
      }
      if (query.includes("OrderImportDetail")) {
        calls.push(`order:${String(variables.id)}`);
        if (options.failDetailOf === variables.id) {
          return Response.json({ errors: [{ message: "Internal error" }] });
        }
        const order = orders.find((candidate) => candidate.id === variables.id);
        return Response.json({ data: { order: order ? { ...order, lineItems: linePage(order, 0) } : null } });
      }
      if (query.includes("OrderImportLineItems")) {
        const start = Number.parseInt(String(variables.cursor).slice(2), 10);
        calls.push(`lines:${String(variables.id)}:${start}`);
        const order = orders.find((candidate) => candidate.id === variables.id) as Json;
        return Response.json({ data: { order: { lineItems: linePage(order, start) } } });
      }
      throw new Error(`unexpected query ${query}`);
    },
  };
}

// ---------------------------------------------------------------------------

const createdShopIds: string[] = [];

async function createShop(): Promise<string> {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: {
      shopifyGid: `gid://shopify/Shop/test-${suffix}`,
      myshopifyDomain: `pg006-${suffix}.myshopify.com`,
      name: "PG-006 test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: false,
      installedAt: new Date(at),
    },
  });
  createdShopIds.push(shop.id);
  return shop.id;
}

/** Catalog fixture as PG-005 would have written it. */
async function createCatalog(shopId: string, key: string, unitCost: string | null) {
  const item = await prisma.inventoryItem.create({
    data: {
      shopId,
      shopifyGid: `gid://shopify/InventoryItem/${key}`,
      unitCost: unitCost === null ? null : new Decimal(unitCost),
      unitCostCurrencyCode: unitCost === null ? null : "EUR",
      shopifyUpdatedAt: new Date(at),
    },
  });
  const product = await prisma.product.create({
    data: {
      shopId, shopifyGid: `gid://shopify/Product/${key}`, title: `Product ${key}`, status: "ACTIVE",
      shopifyCreatedAt: new Date(at), shopifyUpdatedAt: new Date(at),
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      shopId, productId: product.id, inventoryItemId: item.id, shopifyGid: `gid://shopify/ProductVariant/${key}`,
      title: "Default", price: new Decimal(100), priceCurrencyCode: "EUR",
    },
  });
  return { item, product, variant };
}

const loadOrder = (shopId: string, gid: string) =>
  prisma.order.findUniqueOrThrow({
    where: { shopId_shopifyGid: { shopId, shopifyGid: gid } },
    include: {
      lines: { orderBy: { shopifyGid: "asc" }, include: { discountAllocations: true, taxes: true, costSnapshot: true } },
      shippingLines: { orderBy: { position: "asc" }, include: { taxes: true } },
      transactions: { orderBy: { shopifyGid: "asc" }, include: { fees: { orderBy: { position: "asc" } } } },
      refunds: { include: { lines: { orderBy: { position: "asc" } }, shippingLines: true, adjustments: true } },
    },
  });

const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof OrderImportError && error.code === code);

after(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

// A complete order covering lines, shipping, transactions, refund and adjustment.
function completeOrder(): Json {
  return shopifyOrder("900", {
    lineItems: page([
      lineItem("1", {
        quantity: 2,
        currentQuantity: 1,
        refundableQuantity: 1,
        originalUnitPriceSet: bag("50.0"),
        discountAllocations: [{ allocatedAmountSet: bag("5.0") }, { allocatedAmountSet: bag("2.5") }],
        taxLines: [{ title: "TVA", rate: 0.2, priceSet: bag("18.5") }],
      }),
      lineItem("2", { product: null, variant: null, sku: null }),
    ]),
    shippingLines: page([
      {
        id: "gid://shopify/ShippingLine/1", title: "Standard", code: "STD", source: "shopify", carrierIdentifier: null,
        isRemoved: false, originalPriceSet: bag("10.0"), discountedPriceSet: bag("10.0"),
        currentDiscountedPriceSet: bag("10.0"), taxLines: [{ title: "TVA", rate: 0.2, priceSet: bag("2.0") }],
      },
      {
        id: null, title: "Express", code: null, source: null, carrierIdentifier: null, isRemoved: true,
        originalPriceSet: bag("25.0"), discountedPriceSet: bag("25.0"), currentDiscountedPriceSet: bag("0.0"), taxLines: [],
      },
    ]),
    transactions: [
      {
        id: "gid://shopify/OrderTransaction/1", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments",
        formattedGateway: "Shopify Payments", test: false, errorCode: null, processedAt: at, createdAt: at,
        amountSet: bag("210.0"), settlementCurrency: "EUR", settlementCurrencyRate: "1.0", parentTransaction: null,
        fees: [{
          type: "processing_fee", flatFeeName: null, rateName: "international_card_not_present", rate: "0.027",
          amount: { amount: "5.92", currencyCode: "EUR" }, flatFee: { amount: "0.25", currencyCode: "EUR" },
          taxAmount: { amount: "0.0", currencyCode: "EUR" },
        }],
      },
      {
        id: "gid://shopify/OrderTransaction/2", kind: "REFUND", status: "PENDING", gateway: "shopify_payments",
        formattedGateway: "Shopify Payments", test: false, errorCode: null, processedAt: at, createdAt: at,
        amountSet: bag("60.0"), settlementCurrency: null, settlementCurrencyRate: null,
        parentTransaction: { id: "gid://shopify/OrderTransaction/1" }, fees: [],
      },
    ],
    refunds: [
      {
        id: "gid://shopify/Refund/1", createdAt: at, updatedAt: at, totalRefundedSet: bag("0.0"),
        refundLineItems: page([
          {
            id: "gid://shopify/RefundLineItem/1", quantity: 1, restockType: "RETURN", restocked: true,
            lineItem: { id: "gid://shopify/LineItem/1" }, subtotalSet: bag("50.0"), totalTaxSet: bag("10.0"),
          },
        ]),
        refundShippingLines: page([{ subtotalAmountSet: bag("0.0"), taxAmountSet: bag("0.0") }]),
        orderAdjustments: page([{ reason: "REFUND_DISCREPANCY", amountSet: bag("60.0"), taxAmountSet: bag("0.0") }]),
        transactions: page([{ id: "gid://shopify/OrderTransaction/2" }]),
      },
    ],
  });
}

describe("importShopifyOrders", () => {
  it("1-8. imports a complete order with every child, refund linked to its transaction", async () => {
    const shopId = await createShop();
    await createCatalog(shopId, "1", "40");
    const result = await importShopifyOrders({ shopId, admin: fakeAdmin([completeOrder()]) });
    assert.deepEqual(result, { orders: 1, orderLines: 2, snapshotsCreated: 2 });

    const order = await loadOrder(shopId, "gid://shopify/Order/900");
    assert.equal(order.customerShopifyGid, "gid://shopify/Customer/42");
    assert.equal(order.totalWeightGrams, 1200n);
    assert.equal(order.totalPrice.toString(), "110");
    assert.equal(order.originalTotalDuties, null);

    // 2/3. lines, discounts, taxes
    assert.equal(order.lines.length, 2);
    const [first, second] = order.lines;
    assert.equal(first.quantity, 2);
    assert.deepEqual(first.discountAllocations.map((item) => item.amount.toString()).sort(), ["2.5", "5"]);
    assert.equal(first.taxes[0].amount.toString(), "18.5");
    assert.equal(first.taxes[0].rate?.toString(), "0.2");
    assert.equal(second.sku, null);

    // 4. shipping and shipping tax, removed line kept
    assert.deepEqual(order.shippingLines.map((line) => [line.shopifyGid, line.isRemoved]), [
      ["gid://shopify/ShippingLine/1", false],
      [null, true],
    ]);
    assert.equal(order.shippingLines[0].taxes[0].amount.toString(), "2");

    // 5. transactions and fees, parent linked, nothing interpreted
    assert.equal(order.transactions.length, 2);
    const [sale, refundTransaction] = order.transactions;
    assert.equal(sale.fees.length, 1);
    assert.equal(sale.fees[0].amount.toString(), "5.92");
    assert.equal(sale.fees[0].rate?.toString(), "0.027");
    assert.equal(refundTransaction.status, "PENDING");
    assert.equal(refundTransaction.fees.length, 0, "fees=[] stays empty");
    assert.equal(refundTransaction.parentTransactionId, sale.id);

    // 6/7/8. refund, refund line, refund shipping line, adjustment, transaction link
    const [refund] = order.refunds;
    assert.equal(refund.lines.length, 1);
    assert.equal(refund.lines[0].orderLineId, first.id);
    assert.equal(refund.lines[0].restockType, "RETURN");
    assert.equal(refund.shippingLines.length, 1);
    assert.deepEqual(refund.adjustments.map((item) => [item.reason, item.amount.toString()]), [["REFUND_DISCREPANCY", "60"]]);
    assert.equal(refundTransaction.refundId, refund.id);
    assert.equal(sale.refundId, null);
  });

  for (const [amount, expected] of [["-5.00", "-5"], ["5.00", "5"], ["0.00", "0"]]) {
    it(`refund adjustment amount ${amount} is stored as signed Decimal ${expected}`, async () => {
      const shopId = await createShop();
      const order = completeOrder();
      const [refund] = order.refunds as Json[];
      refund.orderAdjustments = page([
        { reason: "REFUND_DISCREPANCY", amountSet: bag(amount), taxAmountSet: bag("0.00") },
      ]);
      await importShopifyOrders({ shopId, admin: fakeAdmin([order]) });
      const [adjustment] = await prisma.refundOrderAdjustment.findMany({ where: { shopId } });
      assert.equal(adjustment.amount.toString(), expected);
      assert.ok(adjustment.amount.eq(new Decimal(amount)), "no absolute value");
      assert.ok(adjustment.taxAmount.isZero());
    });
  }

  it("negative amounts stay rejected outside refund adjustments", async () => {
    const shopId = await createShop();
    await rejectsWith(
      importShopifyOrders({ shopId, admin: fakeAdmin([shopifyOrder("1", { totalPriceSet: bag("-5.00") })]) }),
      "INVALID_MONEY",
    );
  });

  it("9/11/14. links existing catalog rows and snapshots the known cost as historical", async () => {
    const shopId = await createShop();
    const { product, variant } = await createCatalog(shopId, "1", "40");
    await importShopifyOrders({ shopId, admin: fakeAdmin([shopifyOrder("1")]) });

    const [line] = (await loadOrder(shopId, "gid://shopify/Order/1")).lines;
    assert.equal(line.productId, product.id);
    assert.equal(line.variantId, variant.id);
    assert.equal(line.costSnapshot?.source, "SHOPIFY_UNIT_COST");
    assert.equal(line.costSnapshot?.unitCost?.toString(), "40");
    assert.equal(line.costSnapshot?.currencyCode, "EUR");
    assert.equal(line.costSnapshot?.inventoryItemShopifyGid, "gid://shopify/InventoryItem/1");
    assert.equal(line.costSnapshot?.historicalApproximation, true);
  });

  it("10/12. unknown variant: null FKs, GIDs kept, MISSING snapshot", async () => {
    const shopId = await createShop();
    await importShopifyOrders({ shopId, admin: fakeAdmin([shopifyOrder("1")]) });
    const [line] = (await loadOrder(shopId, "gid://shopify/Order/1")).lines;
    assert.equal(line.productId, null);
    assert.equal(line.variantId, null);
    assert.equal(line.variantShopifyGid, "gid://shopify/ProductVariant/1");
    assert.equal(line.costSnapshot?.source, "MISSING");
    assert.equal(line.costSnapshot?.unitCost, null);
    assert.equal(line.costSnapshot?.currencyCode, null);
    assert.equal(line.costSnapshot?.inventoryItemShopifyGid, "gid://shopify/InventoryItem/1");
    assert.equal(line.costSnapshot?.historicalApproximation, true);
  });

  it("12. catalog variant with a null cost gives a MISSING snapshot", async () => {
    const shopId = await createShop();
    await createCatalog(shopId, "1", null);
    await importShopifyOrders({ shopId, admin: fakeAdmin([shopifyOrder("1")]) });
    const [line] = (await loadOrder(shopId, "gid://shopify/Order/1")).lines;
    assert.ok(line.variantId !== null);
    assert.equal(line.costSnapshot?.source, "MISSING");
    assert.equal(line.costSnapshot?.unitCost, null);
  });

  it("13. a known cost of 0 stays SHOPIFY_UNIT_COST with Decimal 0", async () => {
    const shopId = await createShop();
    await createCatalog(shopId, "1", "0");
    await importShopifyOrders({ shopId, admin: fakeAdmin([shopifyOrder("1")]) });
    const [line] = (await loadOrder(shopId, "gid://shopify/Order/1")).lines;
    assert.equal(line.costSnapshot?.source, "SHOPIFY_UNIT_COST");
    assert.ok(line.costSnapshot?.unitCost?.isZero());
    assert.equal(line.costSnapshot?.currencyCode, "EUR");
  });

  it("15/16. re-import is idempotent and never modifies an existing snapshot", async () => {
    const shopId = await createShop();
    const { item } = await createCatalog(shopId, "1", "40");
    await importShopifyOrders({ shopId, admin: fakeAdmin([completeOrder()]) });
    const before = await loadOrder(shopId, "gid://shopify/Order/900");

    await prisma.inventoryItem.update({ where: { id: item.id }, data: { unitCost: new Decimal(50) } });
    const second = await importShopifyOrders({ shopId, admin: fakeAdmin([completeOrder()]) });
    assert.equal(second.snapshotsCreated, 0);

    const afterImport = await loadOrder(shopId, "gid://shopify/Order/900");
    assert.equal(await prisma.order.count({ where: { shopId } }), 1);
    assert.equal(await prisma.orderLine.count({ where: { shopId } }), 2);
    assert.equal(await prisma.orderTransaction.count({ where: { shopId } }), 2);
    assert.equal(await prisma.refund.count({ where: { shopId } }), 1);
    assert.equal(await prisma.refundLine.count({ where: { shopId } }), 1);
    assert.equal(await prisma.transactionFee.count({ where: { shopId } }), 1);
    assert.equal(await prisma.orderLineDiscountAllocation.count({ where: { shopId } }), 2);
    assert.equal(await prisma.shippingLine.count({ where: { shopId } }), 2);
    // Same order lines (never recreated) and identical snapshots, still 40.
    assert.deepEqual(afterImport.lines.map((line) => line.id), before.lines.map((line) => line.id));
    assert.deepEqual(
      afterImport.lines.map((line) => line.costSnapshot),
      before.lines.map((line) => line.costSnapshot),
    );
    assert.equal(afterImport.lines[0].costSnapshot?.unitCost?.toString(), "40");
  });

  it("17. shop A and shop B stay isolated", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    const catalogB = await createCatalog(shopB, "1", "12");
    await importShopifyOrders({ shopId: shopA, admin: fakeAdmin([shopifyOrder("1")]) });
    await importShopifyOrders({ shopId: shopB, admin: fakeAdmin([shopifyOrder("1")]) });

    const [lineA] = (await loadOrder(shopA, "gid://shopify/Order/1")).lines;
    const [lineB] = (await loadOrder(shopB, "gid://shopify/Order/1")).lines;
    assert.notEqual(lineA.id, lineB.id);
    // Shop A never links to shop B's catalog.
    assert.equal(lineA.variantId, null);
    assert.equal(lineA.costSnapshot?.source, "MISSING");
    assert.equal(lineB.variantId, catalogB.variant.id);
    assert.equal(lineB.costSnapshot?.unitCost?.toString(), "12");
  });

  it("18. an amount with more than 6 decimals is rejected and nothing is written", async () => {
    const shopId = await createShop();
    await rejectsWith(
      importShopifyOrders({ shopId, admin: fakeAdmin([shopifyOrder("1", { totalPriceSet: bag("110.1234567") })]) }),
      "INVALID_MONEY",
    );
    assert.equal(await prisma.order.count({ where: { shopId } }), 0);
  });

  it("19. a Shopify error on an order writes no part of that order", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([shopifyOrder("1"), shopifyOrder("2")], { failDetailOf: "gid://shopify/Order/2" });
    await rejectsWith(importShopifyOrders({ shopId, admin }), "SHOPIFY_GRAPHQL_ERROR");
    const gids = (await prisma.order.findMany({ where: { shopId }, select: { shopifyGid: true } })).map((o) => o.shopifyGid);
    assert.deepEqual(gids, ["gid://shopify/Order/1"]);
    assert.equal(await prisma.orderLine.count({ where: { shopId } }), 1);
  });

  it("invalid data inside an order rolls back that order completely", async () => {
    const shopId = await createShop();
    const order = completeOrder();
    // The refund transaction is missing from order.transactions: fails during the DB write.
    order.transactions = (order.transactions as Json[]).slice(0, 1);
    await rejectsWith(importShopifyOrders({ shopId, admin: fakeAdmin([order]) }), "INVALID_SHOPIFY_DATA");
    assert.equal(await prisma.order.count({ where: { shopId } }), 0);
    assert.equal(await prisma.orderLine.count({ where: { shopId } }), 0);
    assert.equal(await prisma.orderLineCostSnapshot.count({ where: { shopId } }), 0);
  });

  it("20. paginates orders", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([shopifyOrder("1"), shopifyOrder("2"), shopifyOrder("3")], { orderPageSize: 2 });
    const result = await importShopifyOrders({ shopId, admin });
    assert.equal(result.orders, 3);
    assert.deepEqual(admin.calls.filter((call) => call.startsWith("orders:")), ["orders:0", "orders:2"]);
  });

  it("21. paginates line items", async () => {
    const shopId = await createShop();
    const order = shopifyOrder("1", { lineItems: page([lineItem("1"), lineItem("2"), lineItem("3")]) });
    const admin = fakeAdmin([order], { lineItemPageSize: 2 });
    const result = await importShopifyOrders({ shopId, admin });
    assert.equal(result.orderLines, 3);
    assert.ok(admin.calls.includes("lines:gid://shopify/Order/1:2"));
    assert.equal(await prisma.orderLine.count({ where: { shopId } }), 3);
  });

  it("hasNextPage without endCursor is rejected", async () => {
    const shopId = await createShop();
    const order = shopifyOrder("1", {
      shippingLines: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
    });
    await rejectsWith(importShopifyOrders({ shopId, admin: fakeAdmin([order]) }), "INVALID_SHOPIFY_DATA");
    assert.equal(await prisma.order.count({ where: { shopId } }), 0);
  });

  it("unknown shop is rejected before any Shopify call", async () => {
    const admin = fakeAdmin([]);
    await rejectsWith(importShopifyOrders({ shopId: randomUUID(), admin }), "SHOP_NOT_FOUND");
    assert.deepEqual(admin.calls, []);
  });
});
