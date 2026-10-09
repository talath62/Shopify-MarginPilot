import { Prisma } from "@prisma/client";

import prisma from "../db.server.ts";
import type { AdminGraphqlClient } from "./shopify-catalog-sync.server.ts";

/**
 * PG-006: imports the Shopify orders of the last 60 days into PG-001 tables and
 * creates the immutable COGS snapshot of each new order line.
 * See docs/PG-006-shopify-order-import.md. Data only: no profit, no business rule.
 */

export interface OrderImportResult {
  orders: number;
  orderLines: number;
  snapshotsCreated: number;
}

export type OrderImportErrorCode =
  | "SHOP_NOT_FOUND"
  | "SHOPIFY_GRAPHQL_ERROR"
  | "INVALID_SHOPIFY_DATA"
  | "INVALID_MONEY";

export class OrderImportError extends Error {
  readonly code: OrderImportErrorCode;

  constructor(code: OrderImportErrorCode, message: string) {
    super(message);
    this.name = "OrderImportError";
    this.code = code;
  }
}

const IMPORT_WINDOW_DAYS = 60;
// Order.transactions and Order.refunds are plain lists, not connections:
// a list as long as its limit may be truncated and is rejected.
const TRANSACTIONS_LIMIT = 100;
const REFUNDS_LIMIT = 50;

const MONEY = `fragment M on MoneyBag { shopMoney { amount currencyCode } }`;
const LINE_ITEM_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    id title variantTitle sku quantity currentQuantity refundableQuantity isGiftCard
    product { id }
    variant { id inventoryItem { id } }
    originalUnitPriceSet { ...M }
    originalTotalSet { ...M }
    discountAllocations { allocatedAmountSet { ...M } }
    taxLines { title rate priceSet { ...M } }
  }
`;
const REFUND_LINE_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { id quantity restockType restocked lineItem { id } subtotalSet { ...M } totalTaxSet { ...M } }
`;

const ORDERS_QUERY = `#graphql
  query OrderImportPage($cursor: String, $query: String!) {
    orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
`;

const ORDER_QUERY = `#graphql
  query OrderImportDetail($id: ID!) {
    order(id: $id) {
      id name number test createdAt updatedAt processedAt cancelledAt cancelReason
      currencyCode presentmentCurrencyCode taxesIncluded dutiesIncluded
      displayFinancialStatus displayFulfillmentStatus totalWeight
      customer { id }
      subtotalPriceSet { ...M } totalPriceSet { ...M } currentTotalPriceSet { ...M }
      totalDiscountsSet { ...M } currentTotalDiscountsSet { ...M }
      totalTaxSet { ...M } currentTotalTaxSet { ...M } currentShippingPriceSet { ...M }
      totalTipReceivedSet { ...M } originalTotalDutiesSet { ...M } currentTotalDutiesSet { ...M }
      originalTotalAdditionalFeesSet { ...M } currentTotalAdditionalFeesSet { ...M }
      totalReceivedSet { ...M } netPaymentSet { ...M } totalRefundedSet { ...M }
      totalRefundedShippingSet { ...M } totalOutstandingSet { ...M }
      shippingLines(first: 50, includeRemovals: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title code source carrierIdentifier isRemoved
          originalPriceSet { ...M } discountedPriceSet { ...M } currentDiscountedPriceSet { ...M }
          taxLines { title rate priceSet { ...M } }
        }
      }
      lineItems(first: 100) { ${LINE_ITEM_FIELDS} }
      transactions(first: ${TRANSACTIONS_LIMIT}) {
        id kind status gateway formattedGateway test errorCode processedAt createdAt
        amountSet { ...M } settlementCurrency settlementCurrencyRate
        parentTransaction { id }
        fees {
          type flatFeeName rateName rate
          amount { amount currencyCode } flatFee { amount currencyCode } taxAmount { amount currencyCode }
        }
      }
      refunds(first: ${REFUNDS_LIMIT}) {
        id createdAt updatedAt totalRefundedSet { ...M }
        refundLineItems(first: 100) { ${REFUND_LINE_FIELDS} }
        refundShippingLines(first: 50) {
          pageInfo { hasNextPage endCursor }
          nodes { subtotalAmountSet { ...M } taxAmountSet { ...M } }
        }
        orderAdjustments(first: 50) {
          pageInfo { hasNextPage endCursor }
          nodes { reason amountSet { ...M } taxAmountSet { ...M } }
        }
        transactions(first: 50) { pageInfo { hasNextPage endCursor } nodes { id } }
      }
    }
  }
  ${MONEY}
`;

const LINE_ITEMS_QUERY = `#graphql
  query OrderImportLineItems($id: ID!, $cursor: String) {
    order(id: $id) { lineItems(first: 100, after: $cursor) { ${LINE_ITEM_FIELDS} } }
  }
  ${MONEY}
`;

const REFUND_LINES_QUERY = `#graphql
  query OrderImportRefundLines($id: ID!, $cursor: String) {
    refund(id: $id) { refundLineItems(first: 100, after: $cursor) { ${REFUND_LINE_FIELDS} } }
  }
  ${MONEY}
`;

/**
 * Imports the orders created in the last 60 days for one shop.
 * Each order is fetched completely, validated, then written in its own DB
 * transaction (no transaction is open during Shopify calls).
 */
export async function importShopifyOrders({
  shopId,
  admin,
}: {
  shopId: string;
  admin: AdminGraphqlClient;
}): Promise<OrderImportResult> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (shop === null) {
    throw new OrderImportError("SHOP_NOT_FOUND", `no shop ${shopId}`);
  }

  const since = new Date(Date.now() - IMPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const query = `created_at:>=${since.toISOString().slice(0, 10)}`;
  const result: OrderImportResult = { orders: 0, orderLines: 0, snapshotsCreated: 0 };

  let cursor: string | null = null;
  do {
    const data = await runQuery(admin, ORDERS_QUERY, { cursor, query });
    const connection = requireConnection(data.orders, "orders");
    for (const node of connection.nodes) {
      const gid = requireGid((node as { id?: unknown })?.id, "Order");
      const order = await fetchOrder(admin, gid);
      const written = await persistOrder(shopId, order);
      result.orders += 1;
      result.orderLines += order.lines.length;
      result.snapshotsCreated += written.snapshotsCreated;
    }
    cursor = nextCursor(connection.pageInfo);
  } while (cursor !== null);

  return result;
}

// ---------------------------------------------------------------------------
// Fetch + validation: Shopify JSON -> plain, fully validated order.
// ---------------------------------------------------------------------------

type Money = { amount: Prisma.Decimal; currencyCode: string };

interface ImportedOrder {
  shopifyGid: string;
  data: Omit<Prisma.OrderUncheckedCreateInput, "shopId" | "shopifyGid">;
  lines: ImportedLine[];
  shippingLines: ImportedShippingLine[];
  transactions: ImportedTransaction[];
  refunds: ImportedRefund[];
}
interface ImportedTax {
  title: string | null;
  rate: Prisma.Decimal | null;
  amount: Prisma.Decimal;
  currencyCode: string;
}
interface ImportedLine {
  shopifyGid: string;
  productShopifyGid: string | null;
  variantShopifyGid: string | null;
  inventoryItemShopifyGid: string | null;
  data: {
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    currentQuantity: number;
    refundableQuantity: number;
    originalUnitPrice: Prisma.Decimal;
    originalTotal: Prisma.Decimal;
    currencyCode: string;
    isGiftCard: boolean;
  };
  discountAllocations: Money[];
  taxes: ImportedTax[];
}
interface ImportedShippingLine {
  shopifyGid: string | null;
  title: string;
  code: string | null;
  source: string | null;
  carrierIdentifier: string | null;
  isRemoved: boolean;
  originalPrice: Prisma.Decimal;
  discountedPrice: Prisma.Decimal;
  currentDiscountedPrice: Prisma.Decimal;
  currencyCode: string;
  taxes: ImportedTax[];
}
interface ImportedFee {
  type: string;
  amount: Prisma.Decimal;
  currencyCode: string;
  flatFee: Prisma.Decimal | null;
  flatFeeName: string | null;
  rate: Prisma.Decimal | null;
  rateName: string | null;
  taxAmount: Prisma.Decimal | null;
}
interface ImportedTransaction {
  shopifyGid: string;
  parentShopifyGid: string | null;
  data: {
    kind: string;
    status: string;
    gateway: string | null;
    formattedGateway: string | null;
    amount: Prisma.Decimal;
    currencyCode: string;
    settlementCurrency: string | null;
    settlementCurrencyRate: Prisma.Decimal | null;
    processedAt: Date | null;
    shopifyCreatedAt: Date;
    test: boolean;
    errorCode: string | null;
  };
  fees: ImportedFee[];
}
interface ImportedRefund {
  shopifyGid: string;
  transactionGids: string[];
  data: {
    shopifyCreatedAt: Date | null;
    shopifyUpdatedAt: Date;
    totalRefunded: Prisma.Decimal;
    currencyCode: string;
  };
  lines: {
    shopifyGid: string | null;
    lineItemGid: string;
    quantity: number;
    subtotal: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    currencyCode: string;
    restockType: string;
    restocked: boolean;
  }[];
  shippingLines: { subtotalAmount: Prisma.Decimal; taxAmount: Prisma.Decimal; currencyCode: string }[];
  adjustments: { reason: string; amount: Prisma.Decimal; taxAmount: Prisma.Decimal; currencyCode: string }[];
}

type Json = Record<string, unknown>;

async function fetchOrder(admin: AdminGraphqlClient, gid: string): Promise<ImportedOrder> {
  const data = await runQuery(admin, ORDER_QUERY, { id: gid });
  const raw = data.order as Json | null;
  if (!raw || typeof raw !== "object") {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `order ${gid} not returned`);
  }

  // lineItems: first page, then the remaining pages of this order.
  const firstLines = requireConnection(raw.lineItems, `${gid}.lineItems`);
  const rawLines = [...firstLines.nodes];
  let lineCursor = nextCursor(firstLines.pageInfo);
  while (lineCursor !== null) {
    const page = await runQuery(admin, LINE_ITEMS_QUERY, { id: gid, cursor: lineCursor });
    const connection = requireConnection((page.order as Json | null)?.lineItems, `${gid}.lineItems`);
    rawLines.push(...connection.nodes);
    lineCursor = nextCursor(connection.pageInfo);
  }

  const rawRefunds = requireList(raw.refunds, `${gid}.refunds`, REFUNDS_LIMIT);
  const refunds: ImportedRefund[] = [];
  for (const rawRefund of rawRefunds) {
    refunds.push(await fetchRefund(admin, rawRefund as Json));
  }

  const lines = rawLines.map((line) => mapLine(line as Json));
  const lineGids = new Set(lines.map((line) => line.shopifyGid));
  for (const refund of refunds) {
    for (const line of refund.lines) {
      if (!lineGids.has(line.lineItemGid)) {
        throw new OrderImportError("INVALID_SHOPIFY_DATA", `refund line of ${refund.shopifyGid} targets unknown ${line.lineItemGid}`);
      }
    }
  }

  return {
    shopifyGid: requireGid(raw.id, "Order"),
    data: mapOrderHeader(raw),
    lines,
    shippingLines: completeNodes(raw.shippingLines, `${gid}.shippingLines`).map((line, position) =>
      mapShippingLine(line as Json, position),
    ),
    transactions: requireList(raw.transactions, `${gid}.transactions`, TRANSACTIONS_LIMIT).map((t) =>
      mapTransaction(t as Json),
    ),
    refunds,
  };
}

async function fetchRefund(admin: AdminGraphqlClient, raw: Json): Promise<ImportedRefund> {
  const gid = requireGid(raw.id, "Refund");
  const firstLines = requireConnection(raw.refundLineItems, `${gid}.refundLineItems`);
  const rawLines = [...firstLines.nodes];
  let cursor = nextCursor(firstLines.pageInfo);
  while (cursor !== null) {
    const page = await runQuery(admin, REFUND_LINES_QUERY, { id: gid, cursor });
    const connection = requireConnection((page.refund as Json | null)?.refundLineItems, `${gid}.refundLineItems`);
    rawLines.push(...connection.nodes);
    cursor = nextCursor(connection.pageInfo);
  }

  const totalRefunded = moneyBag(raw.totalRefundedSet, `${gid}.totalRefundedSet`);
  return {
    shopifyGid: gid,
    transactionGids: completeNodes(raw.transactions, `${gid}.transactions`).map((node) =>
      requireGid((node as Json).id, "OrderTransaction"),
    ),
    data: {
      shopifyCreatedAt: optionalDate(raw.createdAt, `${gid}.createdAt`),
      shopifyUpdatedAt: requireDate(raw.updatedAt, `${gid}.updatedAt`),
      totalRefunded: totalRefunded.amount,
      currencyCode: totalRefunded.currencyCode,
    },
    lines: rawLines.map((node) => {
      const line = node as Json;
      const subtotal = moneyBag(line.subtotalSet, `${gid}.subtotalSet`);
      const tax = moneyBag(line.totalTaxSet, `${gid}.totalTaxSet`);
      return {
        shopifyGid: optionalGid(line.id, "RefundLineItem"),
        lineItemGid: requireGid((line.lineItem as Json | null)?.id, "LineItem"),
        quantity: requireInt(line.quantity, `${gid}.quantity`),
        subtotal: subtotal.amount,
        taxAmount: tax.amount,
        currencyCode: sameCurrency([subtotal, tax], `${gid}.refundLineItem`),
        restockType: requireText(line.restockType, `${gid}.restockType`),
        restocked: requireBoolean(line.restocked, `${gid}.restocked`),
      };
    }),
    shippingLines: completeNodes(raw.refundShippingLines, `${gid}.refundShippingLines`).map((node) => {
      const line = node as Json;
      const subtotal = moneyBag(line.subtotalAmountSet, `${gid}.subtotalAmountSet`);
      const tax = moneyBag(line.taxAmountSet, `${gid}.taxAmountSet`);
      return {
        subtotalAmount: subtotal.amount,
        taxAmount: tax.amount,
        currencyCode: sameCurrency([subtotal, tax], `${gid}.refundShippingLine`),
      };
    }),
    adjustments: completeNodes(raw.orderAdjustments, `${gid}.orderAdjustments`).map((node) => {
      const adjustment = node as Json;
      // Adjustments can be negative in Shopify: signed parser here only.
      const amount = signedMoneyBag(adjustment.amountSet, `${gid}.amountSet`);
      const tax = signedMoneyBag(adjustment.taxAmountSet, `${gid}.taxAmountSet`);
      return {
        reason: requireText(adjustment.reason, `${gid}.reason`),
        amount: amount.amount,
        taxAmount: tax.amount,
        currencyCode: sameCurrency([amount, tax], `${gid}.orderAdjustment`),
      };
    }),
  };
}

function mapOrderHeader(raw: Json): ImportedOrder["data"] {
  const gid = String(raw.id);
  const bag = (key: string) => moneyBag(raw[key], `${gid}.${key}`);
  const optionalBag = (key: string) => (raw[key] === null ? null : bag(key));
  const currencyCode = requireText(raw.currencyCode, `${gid}.currencyCode`);

  // Every shopMoney amount of the order must be in Order.currencyCode.
  const amounts = {
    totalTipReceived: bag("totalTipReceivedSet"),
    originalTotalDuties: optionalBag("originalTotalDutiesSet"),
    currentTotalDuties: optionalBag("currentTotalDutiesSet"),
    originalTotalAdditionalFees: optionalBag("originalTotalAdditionalFeesSet"),
    currentTotalAdditionalFees: optionalBag("currentTotalAdditionalFeesSet"),
    subtotalPrice: bag("subtotalPriceSet"),
    totalPrice: bag("totalPriceSet"),
    currentTotalPrice: bag("currentTotalPriceSet"),
    totalDiscounts: bag("totalDiscountsSet"),
    currentTotalDiscounts: bag("currentTotalDiscountsSet"),
    totalTax: bag("totalTaxSet"),
    currentTotalTax: bag("currentTotalTaxSet"),
    currentShippingPrice: bag("currentShippingPriceSet"),
    totalReceived: bag("totalReceivedSet"),
    netPayment: bag("netPaymentSet"),
    totalRefunded: bag("totalRefundedSet"),
    totalRefundedShipping: bag("totalRefundedShippingSet"),
    totalOutstanding: bag("totalOutstandingSet"),
  };
  for (const [key, value] of Object.entries(amounts)) {
    if (value !== null && value.currencyCode !== currencyCode) {
      throw new OrderImportError("INVALID_SHOPIFY_DATA", `${gid}.${key} is not in ${currencyCode}`);
    }
  }
  const amountOf = (value: Money | null) => (value === null ? null : value.amount);

  return {
    name: requireText(raw.name, `${gid}.name`),
    number: requireInt(raw.number, `${gid}.number`),
    shopifyCreatedAt: requireDate(raw.createdAt, `${gid}.createdAt`),
    shopifyUpdatedAt: requireDate(raw.updatedAt, `${gid}.updatedAt`),
    processedAt: requireDate(raw.processedAt, `${gid}.processedAt`),
    cancelledAt: optionalDate(raw.cancelledAt, `${gid}.cancelledAt`),
    cancelReason: optionalText(raw.cancelReason, `${gid}.cancelReason`),
    test: requireBoolean(raw.test, `${gid}.test`),
    currencyCode,
    presentmentCurrencyCode: requireText(raw.presentmentCurrencyCode, `${gid}.presentmentCurrencyCode`),
    displayFinancialStatus: optionalText(raw.displayFinancialStatus, `${gid}.displayFinancialStatus`),
    displayFulfillmentStatus: requireText(raw.displayFulfillmentStatus, `${gid}.displayFulfillmentStatus`),
    taxesIncluded: requireBoolean(raw.taxesIncluded, `${gid}.taxesIncluded`),
    dutiesIncluded: requireBoolean(raw.dutiesIncluded, `${gid}.dutiesIncluded`),
    // Customer GID only (PG-000 D5): no other customer field is requested.
    customerShopifyGid: optionalGid((raw.customer as Json | null)?.id, "Customer"),
    totalWeightGrams: optionalUnsignedInt64(raw.totalWeight, `${gid}.totalWeight`),
    totalTipReceived: amounts.totalTipReceived.amount,
    originalTotalDuties: amountOf(amounts.originalTotalDuties),
    currentTotalDuties: amountOf(amounts.currentTotalDuties),
    originalTotalAdditionalFees: amountOf(amounts.originalTotalAdditionalFees),
    currentTotalAdditionalFees: amountOf(amounts.currentTotalAdditionalFees),
    subtotalPrice: amounts.subtotalPrice.amount,
    totalPrice: amounts.totalPrice.amount,
    currentTotalPrice: amounts.currentTotalPrice.amount,
    totalDiscounts: amounts.totalDiscounts.amount,
    currentTotalDiscounts: amounts.currentTotalDiscounts.amount,
    totalTax: amounts.totalTax.amount,
    currentTotalTax: amounts.currentTotalTax.amount,
    currentShippingPrice: amounts.currentShippingPrice.amount,
    totalReceived: amounts.totalReceived.amount,
    netPayment: amounts.netPayment.amount,
    totalRefunded: amounts.totalRefunded.amount,
    totalRefundedShipping: amounts.totalRefundedShipping.amount,
    totalOutstanding: amounts.totalOutstanding.amount,
  };
}

function mapLine(raw: Json): ImportedLine {
  const gid = requireGid(raw.id, "LineItem");
  const unitPrice = moneyBag(raw.originalUnitPriceSet, `${gid}.originalUnitPriceSet`);
  const total = moneyBag(raw.originalTotalSet, `${gid}.originalTotalSet`);
  const discountAllocations = requireArray(raw.discountAllocations, `${gid}.discountAllocations`).map((item) =>
    moneyBag((item as Json).allocatedAmountSet, `${gid}.allocatedAmountSet`),
  );
  const taxes = mapTaxes(raw.taxLines, gid);
  const variant = raw.variant as Json | null;
  return {
    shopifyGid: gid,
    productShopifyGid: optionalGid((raw.product as Json | null)?.id, "Product"),
    variantShopifyGid: optionalGid(variant?.id, "ProductVariant"),
    inventoryItemShopifyGid: optionalGid((variant?.inventoryItem as Json | null)?.id, "InventoryItem"),
    data: {
      title: requireText(raw.title, `${gid}.title`),
      variantTitle: optionalText(raw.variantTitle, `${gid}.variantTitle`),
      sku: optionalText(raw.sku, `${gid}.sku`),
      quantity: requireInt(raw.quantity, `${gid}.quantity`),
      currentQuantity: requireInt(raw.currentQuantity, `${gid}.currentQuantity`),
      refundableQuantity: requireInt(raw.refundableQuantity, `${gid}.refundableQuantity`),
      originalUnitPrice: unitPrice.amount,
      originalTotal: total.amount,
      currencyCode: sameCurrency([unitPrice, total, ...discountAllocations, ...taxes], `${gid}`),
      isGiftCard: requireBoolean(raw.isGiftCard, `${gid}.isGiftCard`),
    },
    discountAllocations,
    taxes,
  };
}

function mapShippingLine(raw: Json, position: number): ImportedShippingLine & { position: number } {
  const field = `shippingLines[${position}]`;
  const original = moneyBag(raw.originalPriceSet, `${field}.originalPriceSet`);
  const discounted = moneyBag(raw.discountedPriceSet, `${field}.discountedPriceSet`);
  const current = moneyBag(raw.currentDiscountedPriceSet, `${field}.currentDiscountedPriceSet`);
  const taxes = mapTaxes(raw.taxLines, field);
  return {
    position,
    shopifyGid: optionalGid(raw.id, "ShippingLine"),
    title: requireText(raw.title, `${field}.title`),
    code: optionalText(raw.code, `${field}.code`),
    source: optionalText(raw.source, `${field}.source`),
    carrierIdentifier: optionalText(raw.carrierIdentifier, `${field}.carrierIdentifier`),
    isRemoved: requireBoolean(raw.isRemoved, `${field}.isRemoved`),
    originalPrice: original.amount,
    discountedPrice: discounted.amount,
    currentDiscountedPrice: current.amount,
    currencyCode: sameCurrency([original, discounted, current, ...taxes], field),
    taxes,
  };
}

function mapTaxes(value: unknown, field: string): ImportedTax[] {
  return requireArray(value, `${field}.taxLines`).map((item) => {
    const tax = item as Json;
    const price = moneyBag(tax.priceSet, `${field}.taxLines.priceSet`);
    return {
      title: optionalText(tax.title, `${field}.taxLines.title`),
      // Informational only (PG-000): the amount is the source of truth.
      rate: tax.rate === null || tax.rate === undefined ? null : toRate(tax.rate, `${field}.taxLines.rate`),
      amount: price.amount,
      currencyCode: price.currencyCode,
    };
  });
}

function mapTransaction(raw: Json): ImportedTransaction {
  const gid = requireGid(raw.id, "OrderTransaction");
  const amount = moneyBag(raw.amountSet, `${gid}.amountSet`);
  const fees = requireArray(raw.fees, `${gid}.fees`).map((item): ImportedFee => {
    const fee = item as Json;
    const feeAmount = moneyV2(fee.amount, `${gid}.fees.amount`);
    const flatFee = fee.flatFee === null || fee.flatFee === undefined ? null : moneyV2(fee.flatFee, `${gid}.fees.flatFee`);
    const taxAmount =
      fee.taxAmount === null || fee.taxAmount === undefined ? null : moneyV2(fee.taxAmount, `${gid}.fees.taxAmount`);
    // PG-001 stores one currency for amount, flatFee and taxAmount.
    sameCurrency([feeAmount, ...(flatFee ? [flatFee] : []), ...(taxAmount ? [taxAmount] : [])], `${gid}.fees`);
    return {
      type: requireText(fee.type, `${gid}.fees.type`),
      amount: feeAmount.amount,
      currencyCode: feeAmount.currencyCode,
      flatFee: flatFee?.amount ?? null,
      flatFeeName: optionalText(fee.flatFeeName, `${gid}.fees.flatFeeName`),
      rate: fee.rate === null || fee.rate === undefined ? null : toRate(fee.rate, `${gid}.fees.rate`),
      rateName: optionalText(fee.rateName, `${gid}.fees.rateName`),
      taxAmount: taxAmount?.amount ?? null,
    };
  });
  return {
    shopifyGid: gid,
    parentShopifyGid: optionalGid((raw.parentTransaction as Json | null)?.id, "OrderTransaction"),
    data: {
      kind: requireText(raw.kind, `${gid}.kind`),
      status: requireText(raw.status, `${gid}.status`),
      gateway: optionalText(raw.gateway, `${gid}.gateway`),
      formattedGateway: optionalText(raw.formattedGateway, `${gid}.formattedGateway`),
      amount: amount.amount,
      currencyCode: amount.currencyCode,
      settlementCurrency: optionalText(raw.settlementCurrency, `${gid}.settlementCurrency`),
      settlementCurrencyRate:
        raw.settlementCurrencyRate === null || raw.settlementCurrencyRate === undefined
          ? null
          : toRate(raw.settlementCurrencyRate, `${gid}.settlementCurrencyRate`),
      processedAt: optionalDate(raw.processedAt, `${gid}.processedAt`),
      shopifyCreatedAt: requireDate(raw.createdAt, `${gid}.createdAt`),
      test: requireBoolean(raw.test, `${gid}.test`),
      errorCode: optionalText(raw.errorCode, `${gid}.errorCode`),
    },
    fees,
  };
}

// ---------------------------------------------------------------------------
// Persistence: one DB transaction per order, after all Shopify calls.
// ---------------------------------------------------------------------------

async function persistOrder(shopId: string, order: ImportedOrder): Promise<{ snapshotsCreated: number }> {
  return prisma.$transaction(
    async (tx) => {
      const { id: orderId } = await tx.order.upsert({
        where: { shopId_shopifyGid: { shopId, shopifyGid: order.shopifyGid } },
        create: { shopId, shopifyGid: order.shopifyGid, ...order.data },
        update: order.data,
        select: { id: true },
      });

      // Order lines: upsert by GID, never deleted (their COGS snapshot depends on them).
      const lineIdByGid = new Map<string, string>();
      let snapshotsCreated = 0;
      for (const line of order.lines) {
        const product = line.productShopifyGid
          ? await tx.product.findFirst({
              where: { shopId, shopifyGid: line.productShopifyGid, deletedAt: null },
              select: { id: true },
            })
          : null;
        const variant = line.variantShopifyGid
          ? await tx.productVariant.findFirst({
              where: { shopId, shopifyGid: line.variantShopifyGid, deletedAt: null },
              select: {
                id: true,
                inventoryItem: { select: { shopifyGid: true, unitCost: true, unitCostCurrencyCode: true } },
              },
            })
          : null;

        const data = {
          ...line.data,
          productId: product?.id ?? null,
          variantId: variant?.id ?? null,
          productShopifyGid: line.productShopifyGid,
          variantShopifyGid: line.variantShopifyGid,
        };
        const saved = await tx.orderLine.upsert({
          where: { shopId_shopifyGid: { shopId, shopifyGid: line.shopifyGid } },
          create: { shopId, orderId, shopifyGid: line.shopifyGid, ...data },
          update: data,
          select: { id: true, orderId: true },
        });
        if (saved.orderId !== orderId) {
          throw new OrderImportError("INVALID_SHOPIFY_DATA", `${line.shopifyGid} belongs to another order`);
        }
        lineIdByGid.set(line.shopifyGid, saved.id);

        // Children without Shopify id: replaced as a block.
        await tx.orderLineDiscountAllocation.deleteMany({ where: { shopId, orderLineId: saved.id } });
        await tx.orderLineDiscountAllocation.createMany({
          data: line.discountAllocations.map((item, position) => ({
            shopId, orderLineId: saved.id, position, amount: item.amount, currencyCode: item.currencyCode,
          })),
        });
        await tx.orderLineTax.deleteMany({ where: { shopId, orderLineId: saved.id } });
        await tx.orderLineTax.createMany({
          data: line.taxes.map((tax, position) => ({ shopId, orderLineId: saved.id, position, ...tax })),
        });

        if (await createSnapshotIfAbsent(tx, shopId, saved.id, line, variant?.inventoryItem ?? null)) {
          snapshotsCreated += 1;
        }
      }

      // Shipping lines: no dependent history, replaced as a block (taxes cascade).
      await tx.shippingLine.deleteMany({ where: { shopId, orderId } });
      for (const [position, line] of order.shippingLines.entries()) {
        const { taxes, ...shipping } = line;
        const saved = await tx.shippingLine.create({
          data: { shopId, orderId, ...shipping, position },
          select: { id: true },
        });
        await tx.shippingLineTax.createMany({
          data: taxes.map((tax, taxPosition) => ({ shopId, shippingLineId: saved.id, position: taxPosition, ...tax })),
        });
      }

      // Refunds: upsert by GID; lines by GID when present, else (refundId, position).
      const refundIdByGid = new Map<string, string>();
      const refundGidByTransactionGid = new Map<string, string>();
      for (const refund of order.refunds) {
        const { id: refundId } = await tx.refund.upsert({
          where: { shopId_shopifyGid: { shopId, shopifyGid: refund.shopifyGid } },
          create: { shopId, orderId, shopifyGid: refund.shopifyGid, ...refund.data },
          update: refund.data,
          select: { id: true },
        });
        refundIdByGid.set(refund.shopifyGid, refundId);
        for (const transactionGid of refund.transactionGids) {
          refundGidByTransactionGid.set(transactionGid, refund.shopifyGid);
        }

        const keptLineIds: string[] = [];
        for (const [position, line] of refund.lines.entries()) {
          const { lineItemGid, shopifyGid, ...rest } = line;
          const lineData = { ...rest, position, orderLineId: lineIdByGid.get(lineItemGid) as string };
          const saved = shopifyGid
            ? await tx.refundLine.upsert({
                where: { shopId_shopifyGid: { shopId, shopifyGid } },
                create: { shopId, refundId, shopifyGid, ...lineData },
                update: lineData,
                select: { id: true },
              })
            : await tx.refundLine.upsert({
                where: { refundId_position: { refundId, position } },
                create: { shopId, refundId, shopifyGid: null, ...lineData },
                update: { ...lineData, shopifyGid: null },
                select: { id: true },
              });
          keptLineIds.push(saved.id);
        }
        await tx.refundLine.deleteMany({ where: { shopId, refundId, id: { notIn: keptLineIds } } });

        await tx.refundShippingLine.deleteMany({ where: { shopId, refundId } });
        await tx.refundShippingLine.createMany({
          data: refund.shippingLines.map((line, position) => ({ shopId, refundId, position, ...line })),
        });
        await tx.refundOrderAdjustment.deleteMany({ where: { shopId, refundId } });
        await tx.refundOrderAdjustment.createMany({
          data: refund.adjustments.map((adjustment, position) => ({ shopId, refundId, position, ...adjustment })),
        });
      }

      // Transactions: upsert by GID, then link parents once all exist.
      const transactionIdByGid = new Map<string, string>();
      for (const transaction of order.transactions) {
        const refundGid = refundGidByTransactionGid.get(transaction.shopifyGid);
        const data = { ...transaction.data, refundId: refundGid ? (refundIdByGid.get(refundGid) as string) : null };
        const { id } = await tx.orderTransaction.upsert({
          where: { shopId_shopifyGid: { shopId, shopifyGid: transaction.shopifyGid } },
          create: { shopId, orderId, shopifyGid: transaction.shopifyGid, ...data },
          update: data,
          select: { id: true },
        });
        transactionIdByGid.set(transaction.shopifyGid, id);
        await tx.transactionFee.deleteMany({ where: { shopId, transactionId: id } });
        await tx.transactionFee.createMany({
          data: transaction.fees.map((fee, position) => ({ shopId, transactionId: id, position, ...fee })),
        });
      }
      for (const transaction of order.transactions) {
        const parentId = transaction.parentShopifyGid ? transactionIdByGid.get(transaction.parentShopifyGid) : null;
        if (transaction.parentShopifyGid && !parentId) {
          throw new OrderImportError("INVALID_SHOPIFY_DATA", `parent of ${transaction.shopifyGid} is not in the order`);
        }
        await tx.orderTransaction.update({
          where: { shopId_shopifyGid: { shopId, shopifyGid: transaction.shopifyGid } },
          data: { parentTransactionId: parentId ?? null },
        });
      }
      for (const transactionGid of refundGidByTransactionGid.keys()) {
        if (!transactionIdByGid.has(transactionGid)) {
          throw new OrderImportError("INVALID_SHOPIFY_DATA", `refund transaction ${transactionGid} is not in order.transactions`);
        }
      }

      return { snapshotsCreated };
    },
    { timeout: 30_000 },
  );
}

/**
 * Creates the COGS snapshot of a line ONLY if none exists. Never updates it.
 * Initial import of past orders: the current cost is an historical approximation.
 */
async function createSnapshotIfAbsent(
  tx: Prisma.TransactionClient,
  shopId: string,
  orderLineId: string,
  line: ImportedLine,
  inventoryItem: { shopifyGid: string; unitCost: Prisma.Decimal | null; unitCostCurrencyCode: string | null } | null,
): Promise<boolean> {
  const existing = await tx.orderLineCostSnapshot.findUnique({ where: { orderLineId }, select: { id: true } });
  if (existing !== null) return false;

  const known = inventoryItem !== null && inventoryItem.unitCost !== null;
  await tx.orderLineCostSnapshot.create({
    data: {
      shopId,
      orderLineId,
      inventoryItemShopifyGid: inventoryItem?.shopifyGid ?? line.inventoryItemShopifyGid,
      unitCost: known ? inventoryItem.unitCost : null,
      currencyCode: known ? inventoryItem.unitCostCurrencyCode : null,
      source: known ? "SHOPIFY_UNIT_COST" : "MISSING",
      historicalApproximation: true,
      capturedAt: new Date(),
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL helpers (same strict rules as PG-005).
// ---------------------------------------------------------------------------

async function runQuery(admin: AdminGraphqlClient, query: string, variables: Json): Promise<Json> {
  let body: { data?: Json | null; errors?: unknown };
  try {
    const response = await admin.graphql(query, { variables });
    body = (await response.json()) as typeof body;
  } catch (error) {
    throw new OrderImportError(
      "SHOPIFY_GRAPHQL_ERROR",
      `Shopify GraphQL call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (body.errors !== undefined && body.errors !== null) {
    throw new OrderImportError("SHOPIFY_GRAPHQL_ERROR", `Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", "GraphQL response has no data");
  }
  return body.data;
}

function requireConnection(value: unknown, field: string): { nodes: unknown[]; pageInfo: unknown } {
  const connection = value as { nodes?: unknown; pageInfo?: unknown } | null | undefined;
  if (typeof connection !== "object" || connection === null || !Array.isArray(connection.nodes)) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: invalid connection`);
  }
  return { nodes: connection.nodes, pageInfo: connection.pageInfo };
}

/** Nodes of a connection that must fit in one page (no follow-up query). */
function completeNodes(value: unknown, field: string): unknown[] {
  const connection = requireConnection(value, field);
  if (nextCursor(connection.pageInfo) !== null) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: more items than one page`);
  }
  return connection.nodes;
}

function nextCursor(pageInfo: unknown): string | null {
  if (typeof pageInfo !== "object" || pageInfo === null) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", "pageInfo is not an object");
  }
  const { hasNextPage, endCursor } = pageInfo as { hasNextPage?: unknown; endCursor?: unknown };
  if (typeof hasNextPage !== "boolean") {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", "pageInfo.hasNextPage is not a boolean");
  }
  if (hasNextPage === false) return null;
  if (typeof endCursor !== "string" || endCursor === "") {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", "hasNextPage without a valid endCursor");
  }
  return endCursor;
}

/** A plain list that reaches its limit may be truncated: rejected. */
function requireList(value: unknown, field: string, limit: number): unknown[] {
  const list = requireArray(value, field);
  if (list.length >= limit) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: ${list.length} items, possibly truncated`);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Value validation. Invalid Shopify data fails the order; nothing is corrected.
// ---------------------------------------------------------------------------

/** Non-negative decimal string compatible with DECIMAL(20,6). */
const MONEY_PATTERN = /^(\d{1,14})(?:\.(\d+))?$/;
/** Same bounds as MONEY_PATTERN, with an optional minus sign. */
const SIGNED_MONEY_PATTERN = /^-?(\d{1,14})(?:\.(\d+))?$/;
/** Rates: DECIMAL(30,15). */
const RATE_PATTERN = /^(\d{1,15})(?:\.(\d+))?$/;

function toMoney(value: unknown, field: string): Prisma.Decimal {
  const match = typeof value === "string" ? MONEY_PATTERN.exec(value) : null;
  if (match === null) {
    throw new OrderImportError("INVALID_MONEY", `${field}: not a DECIMAL(20,6) amount: ${String(value)}`);
  }
  if ((match[2] ?? "").length > 6) {
    throw new OrderImportError("INVALID_MONEY", `${field}: more than 6 decimals: ${value}`);
  }
  return new Prisma.Decimal(value as string);
}

/** DECIMAL(20,6) amount that may be negative. Used only for RefundOrderAdjustment. */
function toSignedMoney(value: unknown, field: string): Prisma.Decimal {
  const match = typeof value === "string" ? SIGNED_MONEY_PATTERN.exec(value) : null;
  if (match === null) {
    throw new OrderImportError("INVALID_MONEY", `${field}: not a signed DECIMAL(20,6) amount: ${String(value)}`);
  }
  if ((match[2] ?? "").length > 6) {
    throw new OrderImportError("INVALID_MONEY", `${field}: more than 6 decimals: ${value}`);
  }
  return new Prisma.Decimal(value as string);
}

/** Rates arrive as Decimal strings or JSON numbers (TaxLine.rate is a Float). */
function toRate(value: unknown, field: string): Prisma.Decimal {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const match = typeof text === "string" ? RATE_PATTERN.exec(text) : null;
  if (match === null || (match[2] ?? "").length > 15) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: not a DECIMAL(30,15) rate: ${String(value)}`);
  }
  return new Prisma.Decimal(text as string);
}

function moneyV2(value: unknown, field: string): Money {
  const money = value as { amount?: unknown; currencyCode?: unknown } | null;
  if (typeof money !== "object" || money === null) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: missing money`);
  }
  return { amount: toMoney(money.amount, field), currencyCode: requireText(money.currencyCode, `${field}.currencyCode`) };
}

/** Always shopMoney (PG-000 §3.1). */
function moneyBag(value: unknown, field: string): Money {
  const bag = value as { shopMoney?: unknown } | null;
  if (typeof bag !== "object" || bag === null) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: missing MoneyBag`);
  }
  return moneyV2(bag.shopMoney, `${field}.shopMoney`);
}

/** shopMoney of a MoneyBag whose amount may be negative (RefundOrderAdjustment only). */
function signedMoneyBag(value: unknown, field: string): Money {
  const bag = value as { shopMoney?: unknown } | null;
  const money = (typeof bag === "object" && bag !== null ? bag.shopMoney : null) as
    | { amount?: unknown; currencyCode?: unknown }
    | null
    | undefined;
  if (typeof money !== "object" || money === null) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: missing MoneyBag`);
  }
  return {
    amount: toSignedMoney(money.amount, `${field}.shopMoney`),
    currencyCode: requireText(money.currencyCode, `${field}.shopMoney.currencyCode`),
  };
}

/** One currency column per row: every amount of the row must share it. */
function sameCurrency(values: readonly { currencyCode: string }[], field: string): string {
  const [first, ...rest] = values;
  if (!first || rest.some((value) => value.currencyCode !== first.currencyCode)) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: mixed or missing currencies`);
  }
  return first.currencyCode;
}

function requireGid(value: unknown, type: string): string {
  if (typeof value !== "string" || !value.startsWith(`gid://shopify/${type}/`)) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `invalid ${type} id: ${String(value)}`);
  }
  return value;
}

function optionalGid(value: unknown, type: string): string | null {
  return value === null || value === undefined ? null : requireGid(value, type);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: expected a string`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : requireText(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: expected a boolean`);
  }
  return value;
}

/** Unit counts (Int), not money. */
function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: expected a non-negative integer`);
  }
  return value;
}

/** UnsignedInt64 is serialized as a string of digits. */
function optionalUnsignedInt64(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: invalid UnsignedInt64 ${String(value)}`);
  }
  return BigInt(value);
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: expected a list`);
  }
  return value;
}

function requireDate(value: unknown, field: string): Date {
  const date = typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new OrderImportError("INVALID_SHOPIFY_DATA", `${field}: invalid date ${String(value)}`);
  }
  return date;
}

function optionalDate(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : requireDate(value, field);
}
