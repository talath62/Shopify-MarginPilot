import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import prisma from "../../db.server.ts";
import { Decimal } from "../../domain/profit-engine/money.ts";
import { CatalogSyncError, syncShopifyCatalog } from "../shopify-catalog-sync.server.ts";
import type { AdminGraphqlClient } from "../shopify-catalog-sync.server.ts";

// Deterministic fake Shopify GraphQL + real PostgreSQL (DATABASE_URL).
// Fixtures live in dedicated shops; `after` deletes only those shops.

interface FakeVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  inventoryItemId: string;
  unitCost: { amount: string; currencyCode: string } | null;
}
interface FakeProduct {
  id: string;
  title: string;
  status: string;
  variants: FakeVariant[];
}

const at = "2026-10-08T10:00:00Z";

function variant(key: string, overrides: Partial<FakeVariant> = {}): FakeVariant {
  return {
    id: `gid://shopify/ProductVariant/${key}`,
    title: `Variant ${key}`,
    sku: `SKU-${key}`,
    price: "885.95",
    inventoryItemId: `gid://shopify/InventoryItem/${key}`,
    unitCost: { amount: "400.0", currencyCode: "EUR" },
    ...overrides,
  };
}

function product(key: string, variants: FakeVariant[], overrides: Partial<FakeProduct> = {}): FakeProduct {
  return { id: `gid://shopify/Product/${key}`, title: `Product ${key}`, status: "ACTIVE", variants, ...overrides };
}

/** Serves the catalog page by page, like admin.graphql would. */
function fakeAdmin(
  catalog: FakeProduct[],
  options: {
    productPageSize?: number;
    variantPageSize?: number;
    failAtProductPage?: number;
    /** Replaces the first variants connection of this product id. */
    corruptVariants?: { productId: string; variants: unknown };
    /** Replaces the products pageInfo of every page. */
    corruptProductPageInfo?: unknown;
  } = {},
): AdminGraphqlClient & { calls: string[] } {
  const productPageSize = options.productPageSize ?? 100;
  const variantPageSize = options.variantPageSize ?? 100;
  const calls: string[] = [];

  const variantConnection = (variants: FakeVariant[], start: number, productId: string) => {
    const page = variants.slice(start, start + variantPageSize);
    const end = start + page.length;
    return {
      pageInfo: { hasNextPage: end < variants.length, endCursor: page.length ? `v:${productId}:${end}` : null },
      nodes: page.map((item) => ({
        id: item.id,
        title: item.title,
        sku: item.sku,
        price: item.price,
        inventoryItem: { id: item.inventoryItemId, updatedAt: at, unitCost: item.unitCost },
      })),
    };
  };

  return {
    calls,
    async graphql(query, { variables = {} } = {}) {
      if (query.includes("CatalogProductsPage")) {
        const start = variables.cursor ? Number.parseInt(String(variables.cursor).slice(2), 10) : 0;
        const pageIndex = start / productPageSize;
        calls.push(`products:${pageIndex}`);
        if (options.failAtProductPage === pageIndex) {
          return Response.json({ errors: [{ message: "Throttled" }] });
        }
        const page = catalog.slice(start, start + productPageSize);
        const end = start + page.length;
        return Response.json({
          data: {
            shop: { currencyCode: "EUR" },
            products: {
              pageInfo:
                "corruptProductPageInfo" in options
                  ? options.corruptProductPageInfo
                  : { hasNextPage: end < catalog.length, endCursor: page.length ? `p:${end}` : null },
              nodes: page.map((item) => ({
                id: item.id,
                title: item.title,
                status: item.status,
                createdAt: at,
                updatedAt: at,
                variants:
                  options.corruptVariants?.productId === item.id
                    ? options.corruptVariants.variants
                    : variantConnection(item.variants, 0, item.id),
              })),
            },
          },
        });
      }
      if (query.includes("CatalogProductVariantsPage")) {
        const cursor = String(variables.cursor);
        const start = Number.parseInt(cursor.slice(cursor.lastIndexOf(":") + 1), 10);
        const item = catalog.find((candidate) => candidate.id === variables.productId);
        calls.push(`variants:${String(variables.productId)}:${start}`);
        return Response.json({ data: { product: { variants: variantConnection(item?.variants ?? [], start, String(variables.productId)) } } });
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
      myshopifyDomain: `pg005-${suffix}.myshopify.com`,
      name: "PG-005 test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: true,
      installedAt: new Date(at),
    },
  });
  createdShopIds.push(shop.id);
  return shop.id;
}

const products = (shopId: string) =>
  prisma.product.findMany({ where: { shopId }, orderBy: { shopifyGid: "asc" } });
const variants = (shopId: string) =>
  prisma.productVariant.findMany({ where: { shopId }, orderBy: { shopifyGid: "asc" } });
const inventoryItems = (shopId: string) =>
  prisma.inventoryItem.findMany({ where: { shopId }, orderBy: { shopifyGid: "asc" } });

after(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe("syncShopifyCatalog", () => {
  it("1/2. imports one product, one variant and one inventory item with its cost", async () => {
    const shopId = await createShop();
    const result = await syncShopifyCatalog({ shopId, admin: fakeAdmin([product("1", [variant("1")])]) });

    assert.deepEqual(result, { products: 1, variants: 1, inventoryItems: 1, productsSoftDeleted: 0, variantsSoftDeleted: 0 });
    const [savedProduct] = await products(shopId);
    const [savedVariant] = await variants(shopId);
    const [savedItem] = await inventoryItems(shopId);
    assert.equal(savedProduct.shopifyGid, "gid://shopify/Product/1");
    assert.equal(savedProduct.status, "ACTIVE");
    assert.equal(savedProduct.deletedAt, null);
    assert.equal(savedVariant.productId, savedProduct.id);
    assert.equal(savedVariant.inventoryItemId, savedItem.id);
    assert.equal(savedVariant.price.toString(), "885.95");
    assert.equal(savedVariant.priceCurrencyCode, "EUR");
    assert.equal(savedVariant.sku, "SKU-1");
    assert.equal(savedItem.unitCost?.toString(), "400");
    assert.equal(savedItem.unitCostCurrencyCode, "EUR");
  });

  it("3. null unitCost stays null with a null currency", async () => {
    const shopId = await createShop();
    await syncShopifyCatalog({ shopId, admin: fakeAdmin([product("1", [variant("1", { unitCost: null })])]) });
    const [item] = await inventoryItems(shopId);
    assert.equal(item.unitCost, null);
    assert.equal(item.unitCostCurrencyCode, null);
  });

  it("4. unitCost 0 is stored as a real Decimal 0", async () => {
    const shopId = await createShop();
    await syncShopifyCatalog({
      shopId,
      admin: fakeAdmin([product("1", [variant("1", { unitCost: { amount: "0.0", currencyCode: "EUR" } })])]),
    });
    const [item] = await inventoryItems(shopId);
    assert.ok(item.unitCost !== null && Decimal.isDecimal(item.unitCost));
    assert.ok(item.unitCost.isZero());
    assert.equal(item.unitCostCurrencyCode, "EUR");
  });

  it("5. null SKU stays null, empty SKU stays empty", async () => {
    const shopId = await createShop();
    await syncShopifyCatalog({
      shopId,
      admin: fakeAdmin([product("1", [variant("1", { sku: null }), variant("2", { sku: "" })])]),
    });
    assert.deepEqual((await variants(shopId)).map((row) => row.sku), [null, ""]);
  });

  it("6/7. second sync updates title, price and cost without duplicates", async () => {
    const shopId = await createShop();
    await syncShopifyCatalog({ shopId, admin: fakeAdmin([product("1", [variant("1")])]) });
    await syncShopifyCatalog({
      shopId,
      admin: fakeAdmin([
        product("1", [variant("1", { price: "799.5", unitCost: { amount: "450.25", currencyCode: "EUR" } })], {
          title: "Renamed",
          status: "ARCHIVED",
        }),
      ]),
    });
    const savedProducts = await products(shopId);
    const savedVariants = await variants(shopId);
    const savedItems = await inventoryItems(shopId);
    assert.equal(savedProducts.length, 1);
    assert.equal(savedVariants.length, 1);
    assert.equal(savedItems.length, 1);
    assert.equal(savedProducts[0].title, "Renamed");
    assert.equal(savedProducts[0].status, "ARCHIVED");
    assert.equal(savedVariants[0].price.toString(), "799.5");
    assert.equal(savedItems[0].unitCost?.toString(), "450.25");
  });

  it("8. paginates products over 2 pages", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([product("1", [variant("1")]), product("2", [variant("2")]), product("3", [variant("3")])], {
      productPageSize: 2,
    });
    const result = await syncShopifyCatalog({ shopId, admin });
    assert.deepEqual(admin.calls, ["products:0", "products:1"]);
    assert.equal(result.products, 3);
    assert.equal((await products(shopId)).length, 3);
  });

  it("9. paginates the variants of one product over 2 pages", async () => {
    const shopId = await createShop();
    const admin = fakeAdmin([product("1", [variant("1"), variant("2"), variant("3")])], { variantPageSize: 2 });
    const result = await syncShopifyCatalog({ shopId, admin });
    assert.deepEqual(admin.calls, ["products:0", "variants:gid://shopify/Product/1:2"]);
    assert.equal(result.variants, 3);
    assert.equal((await variants(shopId)).length, 3);
  });

  it("10/11/12. soft-deletes missing products and variants, revives returning ones", async () => {
    const shopId = await createShop();
    await syncShopifyCatalog({
      shopId,
      admin: fakeAdmin([product("1", [variant("1"), variant("2")]), product("2", [variant("3")])]),
    });

    // Product 2 disappears, variant 2 disappears.
    const second = await syncShopifyCatalog({ shopId, admin: fakeAdmin([product("1", [variant("1")])]) });
    assert.equal(second.productsSoftDeleted, 1);
    assert.equal(second.variantsSoftDeleted, 2);
    const afterDelete = await products(shopId);
    assert.equal(afterDelete.find((row) => row.shopifyGid.endsWith("/2"))?.deletedAt instanceof Date, true);
    assert.equal(afterDelete.find((row) => row.shopifyGid.endsWith("/1"))?.deletedAt, null);
    const deletedVariants = (await variants(shopId)).filter((row) => row.deletedAt !== null).map((row) => row.shopifyGid);
    assert.deepEqual(deletedVariants.sort(), ["gid://shopify/ProductVariant/2", "gid://shopify/ProductVariant/3"]);
    assert.equal((await products(shopId)).length, 2, "no hard delete");

    // Product 2 comes back.
    const third = await syncShopifyCatalog({
      shopId,
      admin: fakeAdmin([product("1", [variant("1")]), product("2", [variant("3")])]),
    });
    assert.equal(third.productsSoftDeleted, 0);
    const revived = await products(shopId);
    assert.ok(revived.every((row) => row.deletedAt === null));
    assert.equal((await variants(shopId)).find((row) => row.shopifyGid.endsWith("/3"))?.deletedAt, null);
  });

  it("13. a GraphQL error before the end skips the soft-delete phase", async () => {
    const shopId = await createShop();
    await syncShopifyCatalog({
      shopId,
      admin: fakeAdmin([product("1", [variant("1")]), product("2", [variant("2")])]),
    });

    const failing = fakeAdmin([product("1", [variant("1")]), product("2", [variant("2")])], {
      productPageSize: 1,
      failAtProductPage: 1,
    });
    await assert.rejects(
      syncShopifyCatalog({ shopId, admin: failing }),
      (error: unknown) => error instanceof CatalogSyncError && error.code === "SHOPIFY_GRAPHQL_ERROR",
    );
    assert.deepEqual(failing.calls, ["products:0", "products:1"]);
    assert.ok((await products(shopId)).every((row) => row.deletedAt === null));
    assert.ok((await variants(shopId)).every((row) => row.deletedAt === null));
  });

  it("14. shop A and shop B stay isolated", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    await syncShopifyCatalog({ shopId: shopA, admin: fakeAdmin([product("1", [variant("1")])]) });
    await syncShopifyCatalog({
      shopId: shopB,
      admin: fakeAdmin([product("1", [variant("1", { unitCost: { amount: "12", currencyCode: "EUR" } })])]),
    });
    // Same GIDs, separate rows.
    assert.equal((await inventoryItems(shopA))[0].unitCost?.toString(), "400");
    assert.equal((await inventoryItems(shopB))[0].unitCost?.toString(), "12");

    // An empty full sync of B soft-deletes B only.
    await syncShopifyCatalog({ shopId: shopB, admin: fakeAdmin([]) });
    assert.ok((await products(shopB)).every((row) => row.deletedAt !== null));
    assert.ok((await products(shopA)).every((row) => row.deletedAt === null));
    assert.ok((await variants(shopA)).every((row) => row.deletedAt === null));
  });

  it("15. an amount with more than 6 decimals is rejected", async () => {
    const shopId = await createShop();
    for (const admin of [
      fakeAdmin([product("1", [variant("1", { price: "10.1234567" })])]),
      fakeAdmin([product("1", [variant("1", { unitCost: { amount: "1.0000001", currencyCode: "EUR" } })])]),
    ]) {
      await assert.rejects(
        syncShopifyCatalog({ shopId, admin }),
        (error: unknown) => error instanceof CatalogSyncError && error.code === "INVALID_MONEY",
      );
    }
    assert.equal((await variants(shopId)).length, 0);
  });

  it("16. never modifies a historical COGS snapshot", async () => {
    const shopId = await createShop();
    await syncShopifyCatalog({ shopId, admin: fakeAdmin([product("1", [variant("1", { unitCost: { amount: "40", currencyCode: "EUR" } })])]) });
    const [savedVariant] = await variants(shopId);

    // Fixture: an order line whose snapshot captured cost 40.
    const order = await prisma.order.create({
      data: {
        shopId, shopifyGid: `gid://shopify/Order/${randomUUID()}`, name: "#1", number: 1,
        shopifyCreatedAt: new Date(at), shopifyUpdatedAt: new Date(at), processedAt: new Date(at), test: false,
        currencyCode: "EUR", presentmentCurrencyCode: "EUR", displayFulfillmentStatus: "UNFULFILLED",
        taxesIncluded: true, dutiesIncluded: false, totalTipReceived: new Decimal(0), subtotalPrice: new Decimal(0),
        totalPrice: new Decimal(0), currentTotalPrice: new Decimal(0), totalDiscounts: new Decimal(0),
        currentTotalDiscounts: new Decimal(0), totalTax: new Decimal(0), currentTotalTax: new Decimal(0),
        currentShippingPrice: new Decimal(0), totalReceived: new Decimal(0), netPayment: new Decimal(0),
        totalRefunded: new Decimal(0), totalRefundedShipping: new Decimal(0), totalOutstanding: new Decimal(0),
      },
    });
    const line = await prisma.orderLine.create({
      data: {
        shopId, orderId: order.id, shopifyGid: `gid://shopify/LineItem/${randomUUID()}`, variantId: savedVariant.id,
        variantShopifyGid: savedVariant.shopifyGid, title: "Snowboard", quantity: 1, currentQuantity: 1,
        refundableQuantity: 1, originalUnitPrice: new Decimal(100), originalTotal: new Decimal(100),
        currencyCode: "EUR", isGiftCard: false,
      },
    });
    const snapshot = await prisma.orderLineCostSnapshot.create({
      data: {
        shopId, orderLineId: line.id, inventoryItemShopifyGid: "gid://shopify/InventoryItem/1",
        unitCost: new Decimal(40), currencyCode: "EUR", source: "SHOPIFY_UNIT_COST",
        historicalApproximation: false, capturedAt: new Date(at),
      },
    });

    await syncShopifyCatalog({ shopId, admin: fakeAdmin([product("1", [variant("1", { unitCost: { amount: "50", currencyCode: "EUR" } })])]) });

    assert.equal((await inventoryItems(shopId))[0].unitCost?.toString(), "50");
    const unchanged = await prisma.orderLineCostSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });
    assert.deepEqual(unchanged, snapshot);
    assert.equal(unchanged.unitCost?.toString(), "40");
  });

  it("variants with hasNextPage but no endCursor: INVALID_SHOPIFY_DATA, no soft delete", async () => {
    const shopId = await createShop();
    const catalog = [product("1", [variant("1")]), product("2", [variant("2")])];
    await syncShopifyCatalog({ shopId, admin: fakeAdmin(catalog) });

    const corrupted = fakeAdmin(catalog, {
      corruptVariants: {
        productId: "gid://shopify/Product/2",
        variants: {
          pageInfo: { hasNextPage: true, endCursor: null },
          nodes: [],
        },
      },
    });
    await assert.rejects(
      syncShopifyCatalog({ shopId, admin: corrupted }),
      (error: unknown) => error instanceof CatalogSyncError && error.code === "INVALID_SHOPIFY_DATA",
    );
    assert.deepEqual(corrupted.calls, ["products:0"], "no remaining-variants call with a null cursor");
    assert.ok((await products(shopId)).every((row) => row.deletedAt === null));
    assert.ok((await variants(shopId)).every((row) => row.deletedAt === null));
  });

  for (const [name, malformed] of [
    ["missing", undefined],
    ["nodes not an array", { pageInfo: { hasNextPage: false, endCursor: null }, nodes: null }],
    ["pageInfo missing", { nodes: [] }],
  ] as const) {
    it(`malformed variants (${name}): CatalogSyncError, not TypeError`, async () => {
      const shopId = await createShop();
      await assert.rejects(
        syncShopifyCatalog({
          shopId,
          admin: fakeAdmin([product("1", [variant("1")])], {
            corruptVariants: { productId: "gid://shopify/Product/1", variants: malformed },
          }),
        }),
        (error: unknown) => error instanceof CatalogSyncError && error.code === "INVALID_SHOPIFY_DATA",
      );
    });
  }

  for (const target of ["products", "variants"] as const) {
    it(`${target} pageInfo without hasNextPage: INVALID_SHOPIFY_DATA, no soft delete`, async () => {
      const shopId = await createShop();
      const catalog = [product("1", [variant("1")]), product("2", [variant("2")])];
      await syncShopifyCatalog({ shopId, admin: fakeAdmin(catalog) });

      const pageInfo = { endCursor: null };
      const admin =
        target === "products"
          ? fakeAdmin(catalog, { corruptProductPageInfo: pageInfo })
          : fakeAdmin(catalog, {
              corruptVariants: { productId: "gid://shopify/Product/1", variants: { pageInfo, nodes: [] } },
            });
      await assert.rejects(
        syncShopifyCatalog({ shopId, admin }),
        (error: unknown) => error instanceof CatalogSyncError && error.code === "INVALID_SHOPIFY_DATA",
      );
      assert.ok((await products(shopId)).every((row) => row.deletedAt === null));
      assert.ok((await variants(shopId)).every((row) => row.deletedAt === null));
    });
  }

  it("unknown shop is rejected before any Shopify call", async () => {
    const admin = fakeAdmin([]);
    await assert.rejects(
      syncShopifyCatalog({ shopId: randomUUID(), admin }),
      (error: unknown) => error instanceof CatalogSyncError && error.code === "SHOP_NOT_FOUND",
    );
    assert.deepEqual(admin.calls, []);
  });

  it("malformed Shopify data fails explicitly", async () => {
    const shopId = await createShop();
    await assert.rejects(
      syncShopifyCatalog({ shopId, admin: fakeAdmin([product("1", [variant("1")], { id: "not-a-gid" })]) }),
      (error: unknown) => error instanceof CatalogSyncError && error.code === "INVALID_SHOPIFY_DATA",
    );
  });
});
