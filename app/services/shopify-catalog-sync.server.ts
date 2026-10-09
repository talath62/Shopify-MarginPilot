import { Prisma } from "@prisma/client";

import prisma from "../db.server.ts";

/**
 * PG-005: full sync of the CURRENT Shopify catalog (Product, ProductVariant,
 * InventoryItem) into PG-001 tables. See docs/PG-005-shopify-catalog-sync.md.
 * Never touches orders or OrderLineCostSnapshot.
 */

/** Minimal part of the Shopify Admin GraphQL client used here (admin.graphql). */
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

export interface CatalogSyncResult {
  products: number;
  variants: number;
  inventoryItems: number;
  productsSoftDeleted: number;
  variantsSoftDeleted: number;
}

export type CatalogSyncErrorCode =
  | "SHOP_NOT_FOUND"
  | "SHOPIFY_GRAPHQL_ERROR"
  | "INVALID_SHOPIFY_DATA"
  | "INVALID_MONEY";

export class CatalogSyncError extends Error {
  readonly code: CatalogSyncErrorCode;

  constructor(code: CatalogSyncErrorCode, message: string) {
    super(message);
    this.name = "CatalogSyncError";
    this.code = code;
  }
}

const VARIANT_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes {
    id
    title
    sku
    price
    inventoryItem {
      id
      updatedAt
      unitCost { amount currencyCode }
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  query CatalogProductsPage($cursor: String) {
    shop { currencyCode }
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        status
        createdAt
        updatedAt
        variants(first: 100) { ${VARIANT_FIELDS} }
      }
    }
  }
`;

const VARIANTS_QUERY = `#graphql
  query CatalogProductVariantsPage($productId: ID!, $cursor: String) {
    product(id: $productId) {
      variants(first: 100, after: $cursor) { ${VARIANT_FIELDS} }
    }
  }
`;

// Raw GraphQL shapes, validated before use.
interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
interface RawVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  inventoryItem: {
    id: string;
    updatedAt: string;
    unitCost: { amount: string; currencyCode: string } | null;
  };
}
interface RawVariantConnection {
  pageInfo: PageInfo;
  nodes: RawVariant[];
}
interface RawProduct {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  variants: RawVariantConnection;
}

/**
 * Full catalog sync for one shop. The caller provides an authenticated
 * admin client (authenticate.admin / unauthenticated.admin).
 * Soft deletes run only after every Shopify page was read successfully.
 */
export async function syncShopifyCatalog({
  shopId,
  admin,
}: {
  shopId: string;
  admin: AdminGraphqlClient;
}): Promise<CatalogSyncResult> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (shop === null) {
    throw new CatalogSyncError("SHOP_NOT_FOUND", `no shop ${shopId}`);
  }

  const seenProductGids = new Set<string>();
  const seenVariantGids = new Set<string>();
  const seenInventoryItemGids = new Set<string>();
  let shopCurrency: string | null = null;
  let cursor: string | null = null;

  do {
    const data = await runQuery(admin, PRODUCTS_QUERY, { cursor });
    const currency = readString(data, ["shop", "currencyCode"]);
    if (shopCurrency !== null && currency !== shopCurrency) {
      throw new CatalogSyncError("INVALID_SHOPIFY_DATA", "shop currency changed during sync");
    }
    shopCurrency = currency;

    const connection = data.products as { pageInfo: PageInfo; nodes: RawProduct[] } | undefined;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new CatalogSyncError("INVALID_SHOPIFY_DATA", "missing products connection");
    }

    for (const product of connection.nodes) {
      const firstPage = requireVariantConnection(product?.variants, product?.id);
      const remainingCursor = nextCursor(firstPage.pageInfo);
      const variants = [
        ...firstPage.nodes,
        ...(remainingCursor === null
          ? []
          : await loadRemainingVariants(admin, product.id, remainingCursor)),
      ];
      // DB writes happen between Shopify calls, never inside one DB transaction.
      await persistProduct(shopId, shopCurrency, product, variants);
      seenProductGids.add(product.id);
      for (const variant of variants) {
        seenVariantGids.add(variant.id);
        seenInventoryItemGids.add(variant.inventoryItem.id);
      }
    }

    cursor = nextCursor(connection.pageInfo);
  } while (cursor !== null);

  // Reached only when the whole catalog was read.
  const syncTime = new Date();
  const productsSoftDeleted = await softDeleteMissing("product", shopId, seenProductGids, syncTime);
  const variantsSoftDeleted = await softDeleteMissing("variant", shopId, seenVariantGids, syncTime);

  return {
    products: seenProductGids.size,
    variants: seenVariantGids.size,
    inventoryItems: seenInventoryItemGids.size,
    productsSoftDeleted,
    variantsSoftDeleted,
  };
}

async function loadRemainingVariants(
  admin: AdminGraphqlClient,
  productId: string,
  firstCursor: string,
): Promise<RawVariant[]> {
  const variants: RawVariant[] = [];
  let cursor: string | null = firstCursor;
  while (cursor !== null) {
    const data = await runQuery(admin, VARIANTS_QUERY, { productId, cursor });
    const connection = requireVariantConnection(
      (data.product as { variants?: unknown } | null)?.variants,
      productId,
    );
    variants.push(...connection.nodes);
    cursor = nextCursor(connection.pageInfo);
  }
  return variants;
}

async function persistProduct(
  shopId: string,
  shopCurrency: string,
  raw: RawProduct,
  rawVariants: readonly RawVariant[],
): Promise<void> {
  // Validate the whole product before writing anything for it.
  const product = {
    shopifyGid: requireGid(raw.id, "Product"),
    title: requireText(raw.title, `${raw.id}.title`),
    status: requireText(raw.status, `${raw.id}.status`),
    shopifyCreatedAt: requireDate(raw.createdAt, `${raw.id}.createdAt`),
    shopifyUpdatedAt: requireDate(raw.updatedAt, `${raw.id}.updatedAt`),
  };
  const variants = rawVariants.map((variant) => ({
    shopifyGid: requireGid(variant.id, "ProductVariant"),
    title: requireText(variant.title, `${variant.id}.title`),
    sku: variant.sku ?? null,
    price: toMoney(variant.price, `${variant.id}.price`),
    inventoryItem: {
      shopifyGid: requireGid(variant.inventoryItem?.id, "InventoryItem"),
      shopifyUpdatedAt: requireDate(variant.inventoryItem.updatedAt, `${variant.inventoryItem.id}.updatedAt`),
      // Shopify null cost stays null: unknown is never 0.
      unitCost:
        variant.inventoryItem.unitCost === null
          ? null
          : toMoney(variant.inventoryItem.unitCost.amount, `${variant.inventoryItem.id}.unitCost`),
      unitCostCurrencyCode:
        variant.inventoryItem.unitCost === null
          ? null
          : requireText(variant.inventoryItem.unitCost.currencyCode, `${variant.inventoryItem.id}.unitCost.currencyCode`),
    },
  }));

  const { id: productId } = await prisma.product.upsert({
    where: { shopId_shopifyGid: { shopId, shopifyGid: product.shopifyGid } },
    create: { shopId, ...product },
    update: { ...product, deletedAt: null },
    select: { id: true },
  });

  for (const variant of variants) {
    const { id: inventoryItemId } = await prisma.inventoryItem.upsert({
      where: { shopId_shopifyGid: { shopId, shopifyGid: variant.inventoryItem.shopifyGid } },
      create: { shopId, ...variant.inventoryItem },
      update: variant.inventoryItem,
      select: { id: true },
    });
    const data = {
      productId,
      inventoryItemId,
      title: variant.title,
      sku: variant.sku,
      price: variant.price,
      priceCurrencyCode: shopCurrency,
    };
    await prisma.productVariant.upsert({
      where: { shopId_shopifyGid: { shopId, shopifyGid: variant.shopifyGid } },
      create: { shopId, shopifyGid: variant.shopifyGid, ...data },
      update: { ...data, deletedAt: null },
    });
  }
}

/** Soft-deletes active rows of this shop whose GID was not seen. Never a hard delete. */
async function softDeleteMissing(
  model: "product" | "variant",
  shopId: string,
  seen: ReadonlySet<string>,
  syncTime: Date,
): Promise<number> {
  const where = { shopId, deletedAt: null };
  const select = { id: true, shopifyGid: true };
  const active =
    model === "product"
      ? await prisma.product.findMany({ where, select })
      : await prisma.productVariant.findMany({ where, select });
  const missingIds = active.filter((row) => !seen.has(row.shopifyGid)).map((row) => row.id);

  let count = 0;
  // Chunks keep the IN list far below PostgreSQL's bind parameter limit.
  for (let start = 0; start < missingIds.length; start += 1000) {
    const ids = missingIds.slice(start, start + 1000);
    const update = { where: { shopId, id: { in: ids } }, data: { deletedAt: syncTime } };
    const result =
      model === "product"
        ? await prisma.product.updateMany(update)
        : await prisma.productVariant.updateMany(update);
    count += result.count;
  }
  return count;
}

async function runQuery(
  admin: AdminGraphqlClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let body: { data?: Record<string, unknown> | null; errors?: unknown };
  try {
    const response = await admin.graphql(query, { variables });
    body = (await response.json()) as typeof body;
  } catch (error) {
    throw new CatalogSyncError(
      "SHOPIFY_GRAPHQL_ERROR",
      `Shopify GraphQL call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (body.errors !== undefined && body.errors !== null) {
    throw new CatalogSyncError("SHOPIFY_GRAPHQL_ERROR", `Shopify GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", "GraphQL response has no data");
  }
  return body.data;
}

/** A variants connection must have a nodes array and a pageInfo object. */
function requireVariantConnection(value: unknown, productId: unknown): RawVariantConnection {
  const connection = value as Partial<RawVariantConnection> | null | undefined;
  if (
    typeof connection !== "object" ||
    connection === null ||
    !Array.isArray(connection.nodes) ||
    typeof connection.pageInfo !== "object" ||
    connection.pageInfo === null
  ) {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", `invalid variants connection of ${String(productId)}`);
  }
  return connection as RawVariantConnection;
}

function nextCursor(pageInfo: unknown): string | null {
  if (typeof pageInfo !== "object" || pageInfo === null) {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", "pageInfo is not an object");
  }
  const { hasNextPage, endCursor } = pageInfo as { hasNextPage?: unknown; endCursor?: unknown };
  if (typeof hasNextPage !== "boolean") {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", "pageInfo.hasNextPage is not a boolean");
  }
  if (hasNextPage === false) return null;
  if (typeof endCursor !== "string" || endCursor === "") {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", "hasNextPage without a valid endCursor");
  }
  return endCursor;
}

// ---------------------------------------------------------------------------
// Validation. Invalid Shopify data fails the sync; nothing is corrected.
// ---------------------------------------------------------------------------

/** Non-negative decimal string, at most 14 integer digits and 6 decimals (DECIMAL(20,6)). */
const MONEY_PATTERN = /^(\d{1,14})(?:\.(\d+))?$/;

function toMoney(value: unknown, field: string): Prisma.Decimal {
  const match = typeof value === "string" ? MONEY_PATTERN.exec(value) : null;
  if (match === null) {
    throw new CatalogSyncError("INVALID_MONEY", `${field}: not a DECIMAL(20,6) amount: ${String(value)}`);
  }
  if ((match[2] ?? "").length > 6) {
    // PostgreSQL would round it silently: reject instead.
    throw new CatalogSyncError("INVALID_MONEY", `${field}: more than 6 decimals: ${value}`);
  }
  return new Prisma.Decimal(value as string);
}

function requireGid(value: unknown, type: string): string {
  if (typeof value !== "string" || !value.startsWith(`gid://shopify/${type}/`)) {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", `invalid ${type} id: ${String(value)}`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", `${field}: expected a string`);
  }
  return value;
}

function requireDate(value: unknown, field: string): Date {
  const date = typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) {
    throw new CatalogSyncError("INVALID_SHOPIFY_DATA", `${field}: invalid date ${String(value)}`);
  }
  return date;
}

function readString(data: Record<string, unknown>, path: string[]): string {
  let value: unknown = data;
  for (const key of path) {
    value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  }
  return requireText(value, path.join("."));
}
