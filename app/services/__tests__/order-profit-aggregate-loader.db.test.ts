import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import prisma from "../../db.server.ts";
import { Decimal } from "../../domain/profit-engine/money.ts";
import { calculateOrderProfit } from "../../domain/profit-engine/index.ts";
import { normalizeOrderProfitInput } from "../../domain/order-profit-normalizer/index.ts";
import {
  loadOrderProfitNormalizationSource,
  OrderProfitAggregateLoadError,
} from "../order-profit-aggregate-loader.server.ts";

// PostgreSQL integration tests on the existing DATABASE_URL.
// Every fixture lives in shops created here with unique ids; `after` deletes
// those shops only (cascade). No truncate, no reset.

const d = (value: string) => new Decimal(value);
const createdShopIds: string[] = [];

async function createShop(): Promise<string> {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: {
      shopifyGid: `gid://shopify/Shop/test-${suffix}`,
      myshopifyDomain: `pg004-${suffix}.myshopify.com`,
      name: "PG-004 test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: false,
      installedAt: new Date("2026-10-07T00:00:00Z"),
    },
  });
  createdShopIds.push(shop.id);
  return shop.id;
}

async function createOrder(
  shopId: string,
  overrides: { deletedAt?: Date; taxesIncluded?: boolean; name?: string } = {},
): Promise<string> {
  const at = new Date("2026-10-07T10:00:00Z");
  const order = await prisma.order.create({
    data: {
      shopId,
      shopifyGid: `gid://shopify/Order/${randomUUID()}`,
      name: overrides.name ?? "#1001",
      number: 1001,
      shopifyCreatedAt: at,
      shopifyUpdatedAt: at,
      processedAt: at,
      test: false,
      currencyCode: "EUR",
      presentmentCurrencyCode: "EUR",
      displayFulfillmentStatus: "UNFULFILLED",
      taxesIncluded: overrides.taxesIncluded ?? false,
      dutiesIncluded: false,
      deletedAt: overrides.deletedAt ?? null,
      totalTipReceived: d("0"),
      subtotalPrice: d("90"),
      totalPrice: d("100"),
      currentTotalPrice: d("100"),
      totalDiscounts: d("10"),
      currentTotalDiscounts: d("10"),
      totalTax: d("0"),
      currentTotalTax: d("0"),
      currentShippingPrice: d("10"),
      totalReceived: d("100"),
      netPayment: d("100"),
      totalRefunded: d("0"),
      totalRefundedShipping: d("0"),
      totalOutstanding: d("0"),
    },
  });
  return order.id;
}

async function createLine(
  shopId: string,
  orderId: string,
  originalTotal: string,
  quantity = 1,
): Promise<string> {
  const line = await prisma.orderLine.create({
    data: {
      shopId,
      orderId,
      shopifyGid: `gid://shopify/LineItem/${randomUUID()}`,
      title: "Snowboard",
      quantity,
      currentQuantity: quantity,
      refundableQuantity: quantity,
      originalUnitPrice: d(originalTotal),
      originalTotal: d(originalTotal),
      currencyCode: "EUR",
      isGiftCard: false,
    },
  });
  return line.id;
}

async function createTransaction(
  shopId: string,
  orderId: string,
  data: { kind: string; status: string; amount: string; gateway?: string | null; refundId?: string; fees?: string[] },
): Promise<string> {
  const transaction = await prisma.orderTransaction.create({
    data: {
      shopId,
      orderId,
      refundId: data.refundId ?? null,
      shopifyGid: `gid://shopify/OrderTransaction/${randomUUID()}`,
      kind: data.kind,
      status: data.status,
      gateway: data.gateway === undefined ? "shopify_payments" : data.gateway,
      amount: d(data.amount),
      currencyCode: "EUR",
      shopifyCreatedAt: new Date("2026-10-07T10:00:00Z"),
      test: false,
    },
  });
  await prisma.transactionFee.createMany({
    data: (data.fees ?? []).map((fee, position) => ({
      shopId,
      transactionId: transaction.id,
      position,
      type: "processing_fee",
      amount: d(fee),
      currencyCode: "EUR",
    })),
  });
  return transaction.id;
}

async function createRefund(shopId: string, orderId: string, totalRefunded: string): Promise<string> {
  const refund = await prisma.refund.create({
    data: {
      shopId,
      orderId,
      shopifyGid: `gid://shopify/Refund/${randomUUID()}`,
      shopifyUpdatedAt: new Date("2026-10-07T11:00:00Z"),
      totalRefunded: d(totalRefunded),
      currencyCode: "EUR",
    },
  });
  return refund.id;
}

function assertLoadError(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OrderProfitAggregateLoadError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

after(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe("loadOrderProfitNormalizationSource (PostgreSQL)", () => {
  let shopId: string;
  let orderId: string;
  let line1: string;
  let line2: string;
  let refund1: string;
  let refund2: string;

  before(async () => {
    shopId = await createShop();
    orderId = await createOrder(shopId);
    line1 = await createLine(shopId, orderId, "100", 2);
    line2 = await createLine(shopId, orderId, "40.123456");

    await prisma.orderLineDiscountAllocation.createMany({
      data: [
        { shopId, orderLineId: line1, position: 0, amount: d("10"), currencyCode: "EUR" },
        { shopId, orderLineId: line1, position: 1, amount: d("0"), currencyCode: "EUR" },
        { shopId, orderLineId: line2, position: 0, amount: d("1.5"), currencyCode: "EUR" },
      ],
    });
    await prisma.orderLineTax.createMany({
      data: [
        { shopId, orderLineId: line1, position: 0, title: "TVA", rate: d("0.2"), amount: d("18"), currencyCode: "EUR" },
        { shopId, orderLineId: line1, position: 1, amount: d("1"), currencyCode: "EUR" },
      ],
    });
    await prisma.orderLineCostSnapshot.create({
      data: {
        shopId,
        orderLineId: line1,
        inventoryItemShopifyGid: "gid://shopify/InventoryItem/1",
        unitCost: d("40"),
        currencyCode: "EUR",
        source: "SHOPIFY_UNIT_COST",
        historicalApproximation: false,
        capturedAt: new Date("2026-10-07T10:00:00Z"),
      },
    });

    const active = await prisma.shippingLine.create({
      data: {
        shopId, orderId, position: 0, title: "Standard", isRemoved: false,
        originalPrice: d("10"), discountedPrice: d("10"), currentDiscountedPrice: d("10"), currencyCode: "EUR",
      },
    });
    await prisma.shippingLine.create({
      data: {
        shopId, orderId, position: 1, title: "Express", isRemoved: true,
        originalPrice: d("25"), discountedPrice: d("25"), currentDiscountedPrice: d("0"), currencyCode: "EUR",
      },
    });
    await prisma.shippingLineTax.create({
      data: { shopId, shippingLineId: active.id, position: 0, amount: d("2"), currencyCode: "EUR" },
    });

    refund1 = await createRefund(shopId, orderId, "60");
    refund2 = await createRefund(shopId, orderId, "0");
    await prisma.refundLine.createMany({
      data: [
        { shopId, refundId: refund1, orderLineId: line1, position: 0, quantity: 1, subtotal: d("50"), taxAmount: d("10"), currencyCode: "EUR", restockType: "RETURN", restocked: true },
        { shopId, refundId: refund1, orderLineId: line2, position: 1, quantity: 1, subtotal: d("0"), taxAmount: d("0"), currencyCode: "EUR", restockType: "NO_RESTOCK", restocked: false },
        { shopId, refundId: refund2, orderLineId: line1, position: 0, quantity: 1, subtotal: d("50"), taxAmount: d("0"), currencyCode: "EUR", restockType: "CANCEL", restocked: true },
      ],
    });
    await prisma.refundShippingLine.create({
      data: { shopId, refundId: refund1, position: 0, subtotalAmount: d("0"), taxAmount: d("0"), currencyCode: "EUR" },
    });
    await prisma.refundOrderAdjustment.create({
      data: { shopId, refundId: refund2, position: 0, reason: "REFUND_DISCREPANCY", amount: d("50"), taxAmount: d("0"), currencyCode: "EUR" },
    });

    await createTransaction(shopId, orderId, { kind: "SALE", status: "SUCCESS", amount: "250", fees: ["7.01", "0.25"] });
    await createTransaction(shopId, orderId, { kind: "AUTHORIZATION", status: "FAILURE", amount: "250", gateway: null });
    await createTransaction(shopId, orderId, { kind: "REFUND", status: "SUCCESS", amount: "60", refundId: refund1 });
    await createTransaction(shopId, orderId, { kind: "REFUND", status: "PENDING", amount: "50", refundId: refund2, gateway: "shopify_store_credit" });
  });

  it("18-24. loads the complete aggregate, exactly as persisted", async () => {
    const source = await loadOrderProfitNormalizationSource(shopId, orderId);

    assert.deepEqual(source.order, { currencyCode: "EUR", taxesIncluded: false, test: false });

    // 19-20. lines, allocations, taxes, snapshot
    assert.equal(source.orderLines.length, 2);
    const first = source.orderLines.find((line) => line.id === line1);
    const second = source.orderLines.find((line) => line.id === line2);
    assert.ok(first && second);
    assert.equal(first.quantity, 2);
    assert.deepEqual(first.discountAllocations.map((item) => item.amount.toString()), ["10", "0"]);
    assert.deepEqual(first.taxLines.map((item) => item.amount.toString()), ["18", "1"]);
    assert.equal(second.originalTotal.toString(), "40.123456");
    assert.equal(second.taxLines.length, 0);
    // 24. snapshot loaded, absent snapshot stays null
    assert.deepEqual(
      first.costSnapshot && { ...first.costSnapshot, unitCost: first.costSnapshot.unitCost?.toString() },
      { unitCost: "40", currencyCode: "EUR", source: "SHOPIFY_UNIT_COST", historicalApproximation: false },
    );
    assert.equal(second.costSnapshot, null);

    // 21. both shipping lines, removed one included, in position order
    assert.deepEqual(source.shippingLines.map((line) => line.isRemoved), [false, true]);
    assert.equal(source.shippingLines[0].taxLines.length, 1);

    // 22. every transaction and fee, no filtering
    assert.equal(source.transactions.length, 4);
    const kinds = source.transactions.map((t) => `${t.kind}/${t.status}`).sort();
    assert.deepEqual(kinds, ["AUTHORIZATION/FAILURE", "REFUND/PENDING", "REFUND/SUCCESS", "SALE/SUCCESS"]);
    const sale = source.transactions.find((t) => t.kind === "SALE");
    assert.deepEqual(sale?.fees.map((fee) => fee.amount.toString()), ["7.01", "0.25"]);
    assert.equal(source.transactions.find((t) => t.kind === "AUTHORIZATION")?.gateway, null);

    // 23. refunds and their children; transaction.refundId = internal Refund.id
    assert.equal(source.refunds.length, 2);
    const firstRefund = source.refunds.find((refund) => refund.id === refund1);
    const secondRefund = source.refunds.find((refund) => refund.id === refund2);
    assert.ok(firstRefund && secondRefund);
    assert.equal(firstRefund.lines.length, 2);
    assert.deepEqual(firstRefund.lines.map((line) => line.orderLineId), [line1, line2]);
    assert.equal(firstRefund.shippingLines.length, 1);
    assert.equal(secondRefund.lines.length, 1);
    assert.deepEqual(secondRefund.adjustments.map((item) => [item.reason, item.amount.toString()]), [
      ["REFUND_DISCREPANCY", "50"],
    ]);
    assert.deepEqual(
      source.transactions.filter((t) => t.kind === "REFUND").map((t) => t.refundId).sort(),
      [refund1, refund2].sort(),
    );
  });

  it("30. PostgreSQL NUMERIC comes back as Decimal", async () => {
    const source = await loadOrderProfitNormalizationSource(shopId, orderId);
    assert.ok(Decimal.isDecimal(source.orderLines[0].originalTotal));
    assert.ok(Decimal.isDecimal(source.transactions[0].amount));
    assert.ok(Decimal.isDecimal(source.refunds[0].totalRefunded));
  });

  it("25. empty collections come back as []", async () => {
    const emptyOrder = await createOrder(shopId, { name: "#empty" });
    const source = await loadOrderProfitNormalizationSource(shopId, emptyOrder);
    assert.deepEqual(source.orderLines, []);
    assert.deepEqual(source.shippingLines, []);
    assert.deepEqual(source.transactions, []);
    assert.deepEqual(source.refunds, []);
  });

  it("26. unknown order: ORDER_NOT_FOUND", async () => {
    await assertLoadError(loadOrderProfitNormalizationSource(shopId, randomUUID()), "ORDER_NOT_FOUND");
  });

  it("28. soft-deleted order: ORDER_DELETED", async () => {
    const deleted = await createOrder(shopId, { deletedAt: new Date("2026-10-07T12:00:00Z") });
    await assertLoadError(loadOrderProfitNormalizationSource(shopId, deleted), "ORDER_DELETED");
  });

  it("refund linked to another order of the same shop: INCONSISTENT_PERSISTED_DATA", async () => {
    const otherOrder = await createOrder(shopId, { name: "#other" });
    const otherRefund = await createRefund(shopId, otherOrder, "0");
    const order = await createOrder(shopId, { name: "#broken" });
    await createTransaction(shopId, order, { kind: "REFUND", status: "SUCCESS", amount: "1", refundId: otherRefund });
    await assertLoadError(loadOrderProfitNormalizationSource(shopId, order), "INCONSISTENT_PERSISTED_DATA");
  });
});

describe("multi-tenant isolation (PostgreSQL)", () => {
  it("27/29. each shop only sees its own order", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    const orderA = await createOrder(shopA, { name: "#A" });
    const orderB = await createOrder(shopB, { name: "#B" });
    const lineA = await createLine(shopA, orderA, "11");
    const lineB = await createLine(shopB, orderB, "22");

    const sourceA = await loadOrderProfitNormalizationSource(shopA, orderA);
    const sourceB = await loadOrderProfitNormalizationSource(shopB, orderB);
    assert.deepEqual(sourceA.orderLines.map((line) => [line.id, line.originalTotal.toString()]), [[lineA, "11"]]);
    assert.deepEqual(sourceB.orderLines.map((line) => [line.id, line.originalTotal.toString()]), [[lineB, "22"]]);

    await assertLoadError(loadOrderProfitNormalizationSource(shopA, orderB), "ORDER_NOT_FOUND");
    await assertLoadError(loadOrderProfitNormalizationSource(shopB, orderA), "ORDER_NOT_FOUND");
  });
});

describe("pipeline PG-004 -> PG-003 -> PG-002 (PostgreSQL)", () => {
  it("loads, normalizes and calculates without adaptation", async () => {
    const shop = await createShop();
    const order = await createOrder(shop);
    const line = await createLine(shop, order, "100");
    await prisma.orderLineDiscountAllocation.create({
      data: { shopId: shop, orderLineId: line, position: 0, amount: d("10"), currencyCode: "EUR" },
    });
    await prisma.orderLineCostSnapshot.create({
      data: {
        shopId: shop, orderLineId: line, unitCost: d("40"), currencyCode: "EUR",
        source: "SHOPIFY_UNIT_COST", historicalApproximation: false, capturedAt: new Date("2026-10-07T10:00:00Z"),
      },
    });
    await prisma.shippingLine.create({
      data: {
        shopId: shop, orderId: order, position: 0, title: "Standard", isRemoved: false,
        originalPrice: d("10"), discountedPrice: d("10"), currentDiscountedPrice: d("10"), currencyCode: "EUR",
      },
    });
    await createTransaction(shop, order, { kind: "SALE", status: "SUCCESS", amount: "100", fees: ["3"] });

    const source = await loadOrderProfitNormalizationSource(shop, order);
    const input = normalizeOrderProfitInput(source, {
      shippingCost: { status: "verified", amount: d("5") },
      adCost: { status: "verified", amount: d("20") },
      otherCosts: { status: "verified", amount: d("2") },
    });
    const result = calculateOrderProfit(input, { lowMarginThresholdPercent: d("10") });

    assert.equal(input.productRevenueExTax.toString(), "90");
    assert.equal(input.shippingRevenueExTax.toString(), "10");
    assert.equal(input.paymentFees.status, "verified");
    assert.equal(result.netRevenue.toString(), "100");
    assert.equal(result.profitBeforeAds?.toString(), "50");
    assert.equal(result.profit?.toString(), "30");
    assert.equal(result.completeness, "complete");
    assert.equal(result.profitabilityState, "PROFITABLE");
  });
});
