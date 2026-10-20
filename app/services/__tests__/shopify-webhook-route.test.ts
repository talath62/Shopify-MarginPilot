import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import prisma from "../../db.server.ts";
import { handleShopifyWebhook } from "../shopify-webhook-dispatch.server.ts";

// The real Shopify SDK verification (authenticate.webhook), configured like
// app/shopify.server.ts with a test-only secret. Requests are signed with that
// secret exactly as Shopify does; an unsigned or wrongly signed request must be
// rejected by the SDK itself. No custom HMAC check exists in the app.

const SECRET = "pg010-test-only-secret";
const shopify = shopifyApp({
  apiKey: "pg010-test-api-key",
  apiSecretKey: SECRET,
  apiVersion: ApiVersion.October26,
  scopes: ["read_orders", "read_products", "read_customers"],
  appUrl: "https://marginpilot.test",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: { expiringOfflineAccessTokens: true },
});

const createdShopIds: string[] = [];
const createdSessionIds: string[] = [];

async function createShopWithSession(withSession: boolean) {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: {
      shopifyGid: `gid://shopify/Shop/test-${suffix}`,
      myshopifyDomain: `pg010-${suffix}.myshopify.com`,
      name: "PG-010 route test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: false,
      installedAt: new Date("2026-10-20T00:00:00Z"),
    },
  });
  createdShopIds.push(shop.id);
  if (withSession) {
    const id = `offline_${shop.myshopifyDomain}`;
    await prisma.session.create({
      data: { id, shop: shop.myshopifyDomain, state: "", isOnline: false, scope: "read_orders", accessToken: "test-token-not-real" },
    });
    createdSessionIds.push(id);
  }
  return shop;
}

function webhookRequest(shopDomain: string, body: string, hmac: string | null, topic = "orders/create") {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": shopDomain,
    "X-Shopify-API-Version": "2026-10",
    "X-Shopify-Webhook-Id": randomUUID(),
    "X-Shopify-Event-Id": randomUUID(),
    "X-Shopify-Triggered-At": "2026-10-20T00:00:00Z",
  };
  if (hmac !== null) headers["X-Shopify-Hmac-Sha256"] = hmac;
  return new Request("https://marginpilot.test/webhooks/marginpilot", { method: "POST", headers, body });
}

const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("base64");
const handle = (request: Request) => handleShopifyWebhook(request, (signed) => shopify.authenticate.webhook(signed));
const responseOf = async (promise: Promise<Response>) => {
  try {
    return await promise;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown; // the SDK throws its rejection Response
    throw thrown;
  }
};

after(async () => {
  await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe("/webhooks/marginpilot with the real authenticate.webhook", () => {
  const body = JSON.stringify({ id: 8238342537543, admin_graphql_api_id: "gid://shopify/Order/8238342537543" });

  it("18. an unsigned or wrongly signed request is rejected by the SDK, no job", async () => {
    const shop = await createShopWithSession(true);
    for (const hmac of [null, sign(body, "another-secret"), sign(`${body} `)]) {
      const response = await responseOf(handle(webhookRequest(shop.myshopifyDomain, body, hmac)));
      assert.ok(response.status >= 400 && response.status < 500, `status ${response.status}`);
    }
    assert.equal(await prisma.job.count({ where: { shopId: shop.id } }), 0);
  });

  it("a correctly signed order webhook enqueues ORDER_SYNC and answers 200", async () => {
    const shop = await createShopWithSession(true);
    const response = await responseOf(handle(webhookRequest(shop.myshopifyDomain, body, sign(body))));
    assert.equal(response.status, 200);
    const jobs = await prisma.job.findMany({ where: { shopId: shop.id } });
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload, { orderGid: "gid://shopify/Order/8238342537543" });
  });

  it("refunds/create: order_id above 2^53 in the raw JSON gives the exact parent order GID", async () => {
    const shop = await createShopWithSession(true);
    // Raw JSON numbers, exactly as Shopify sends them (JSON.parse would round them).
    const refundBody =
      '{"id":890088186047892319,"order_id":820982911946154508,' +
      '"admin_graphql_api_id":"gid://shopify/Refund/890088186047892319",' +
      '"order_adjustments":[{"id":1,"order_id":820982911946154508}]}';
    assert.notEqual(String(JSON.parse(refundBody).order_id), "820982911946154508", "plain parsing loses precision");

    const response = await responseOf(
      handle(webhookRequest(shop.myshopifyDomain, refundBody, sign(refundBody), "refunds/create")),
    );
    assert.equal(response.status, 200);
    const jobs = await prisma.job.findMany({ where: { shopId: shop.id } });
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload, { orderGid: "gid://shopify/Order/820982911946154508" });
    assert.equal(jobs[0].dedupeKey, "gid://shopify/Order/820982911946154508");
  });

  it("refunds/create with a malformed raw order_id is rejected, no job", async () => {
    const shop = await createShopWithSession(true);
    for (const rawId of ["8.20982911946154508e17", "-5", "1.5", "0"]) {
      const refundBody = `{"id":1,"order_id":${rawId}}`;
      const response = await responseOf(
        handle(webhookRequest(shop.myshopifyDomain, refundBody, sign(refundBody), "refunds/create")),
      );
      assert.equal(response.status, 422, rawId);
    }
    assert.equal(await prisma.job.count({ where: { shopId: shop.id } }), 0);
  });

  it("13. signed webhook after uninstall (no offline session): 200, no job", async () => {
    const shop = await createShopWithSession(false);
    const response = await responseOf(handle(webhookRequest(shop.myshopifyDomain, body, sign(body))));
    assert.equal(response.status, 200);
    assert.equal(await prisma.job.count({ where: { shopId: shop.id } }), 0);
  });
});
