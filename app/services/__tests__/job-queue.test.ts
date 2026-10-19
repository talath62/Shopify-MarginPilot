import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import prisma from "../../db.server.ts";
import {
  backoffMinutes,
  enqueueJob,
  findJobForShop,
  JobQueueError,
  PermanentJobError,
  processJobsOnce,
  sanitizeError,
} from "../job-queue.server.ts";
import type { ClaimedJob } from "../job-queue.server.ts";

// Real PostgreSQL (DATABASE_URL), simulated executors.
// processJobsOnce claims any due job of the database: these tests require a
// database without foreign jobs, which `before` checks. Each test cleans its jobs.

const createdShopIds: string[] = [];
const ORDER = "gid://shopify/Order/1";

async function createShop(): Promise<string> {
  const suffix = randomUUID();
  const shop = await prisma.shop.create({
    data: {
      shopifyGid: `gid://shopify/Shop/test-${suffix}`,
      myshopifyDomain: `pg009-${suffix}.myshopify.com`,
      name: "PG-009 test shop",
      currencyCode: "EUR",
      ianaTimezone: "Europe/Paris",
      taxesIncluded: false,
      installedAt: new Date("2026-10-19T00:00:00Z"),
    },
  });
  createdShopIds.push(shop.id);
  return shop.id;
}

const job = (id: string) => prisma.job.findUniqueOrThrow({ where: { id } });
const dbNow = async () => (await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now;
const makeDue = (id: string) =>
  prisma.$executeRaw`UPDATE "Job" SET "runAt" = now() - interval '1 second' WHERE "id" = ${id}::uuid`;
const ok = async () => {};

before(async () => {
  const foreign = await prisma.job.count();
  assert.equal(foreign, 0, "job tests need a database without existing jobs");
});

afterEach(async () => {
  await prisma.job.deleteMany({ where: { shopId: { in: createdShopIds } } });
});

after(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  await prisma.$disconnect();
});

describe("enqueueJob", () => {
  it("1. creates a PENDING job with default attempts", async () => {
    const shopId = await createShop();
    const { job: created, deduplicated } = await enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER } });
    assert.equal(deduplicated, false);
    assert.equal(created.status, "PENDING");
    assert.equal(created.attempts, 0);
    assert.equal(created.maxAttempts, 5);
    assert.equal(created.lockToken, null);
    assert.deepEqual(created.payload, { orderGid: ORDER });
  });

  it("2. validates payloads at enqueue (exact keys, no secret field)", async () => {
    const shopId = await createShop();
    const invalid: [string, unknown][] = [
      ["ORDER_SYNC", { orderGid: "123" }],
      ["ORDER_SYNC", { orderGid: ORDER, accessToken: "shpat_secret" }],
      ["ORDER_SYNC", null],
      ["ORDER_RECONCILIATION", { updatedSince: "2026-10-19", updatedUntil: "2026-10-20T00:00:00Z" }],
      ["ORDER_RECONCILIATION", { updatedSince: "2026-10-20T00:00:00Z", updatedUntil: "2026-10-19T00:00:00Z" }],
      ["CATALOG_SYNC", { full: true }],
    ];
    for (const [type, payload] of invalid) {
      await assert.rejects(
        enqueueJob({ shopId, type: type as "ORDER_SYNC", payload: payload as { orderGid: string } }),
        (error: unknown) => error instanceof JobQueueError && error.code === "INVALID_JOB_PAYLOAD",
        `${type} ${JSON.stringify(payload)}`,
      );
    }
    await assert.rejects(
      enqueueJob({ shopId, type: "WEBHOOK" as "CATALOG_SYNC", payload: {} }),
      (error: unknown) => error instanceof JobQueueError && error.code === "INVALID_JOB_TYPE",
    );
    await enqueueJob({
      shopId,
      type: "ORDER_RECONCILIATION",
      payload: { updatedSince: "2026-10-19T09:00:00.000Z", updatedUntil: "2026-10-19T10:00:00Z" },
    });
    await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} });
    assert.equal(await prisma.job.count({ where: { shopId } }), 2);
  });

  it("3. unknown shop is rejected", async () => {
    await assert.rejects(
      enqueueJob({ shopId: randomUUID(), type: "CATALOG_SYNC", payload: {} }),
      (error: unknown) => error instanceof JobQueueError && error.code === "SHOP_NOT_FOUND",
    );
  });

  it("4. concurrent enqueues with the same dedupeKey create one PENDING job", async () => {
    const shopId = await createShop();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER }),
      ),
    );
    assert.equal(await prisma.job.count({ where: { shopId } }), 1);
    assert.equal(results.filter((result) => !result.deduplicated).length, 1);
    assert.equal(new Set(results.map((result) => result.job.id)).size, 1);
    // Another key or another type is not deduplicated.
    await enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: "gid://shopify/Order/2" }, dedupeKey: "gid://shopify/Order/2" });
    await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {}, dedupeKey: ORDER });
    assert.equal(await prisma.job.count({ where: { shopId } }), 3);
  });

  it("5. SUCCEEDED, FAILED or RUNNING jobs never block a new request", async () => {
    const shopId = await createShop();
    const enqueue = () => enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER });
    const first = await enqueue();
    await processJobsOnce({ execute: ok, limit: 1 });
    assert.equal((await job(first.job.id)).status, "SUCCEEDED");

    const second = await enqueue();
    assert.equal(second.deduplicated, false);
    // While the second one runs, a new request is kept as a new PENDING job.
    let duringRun: Awaited<ReturnType<typeof enqueue>> | undefined;
    await processJobsOnce({
      limit: 1,
      execute: async () => {
        duringRun = await enqueue();
      },
    });
    assert.equal(duringRun?.deduplicated, false);
    assert.equal((await job(duringRun!.job.id)).status, "PENDING");
  });
});

describe("dedupe on retry", () => {
  const pendingWithKey = (shopId: string) =>
    prisma.job.findMany({ where: { shopId, type: "ORDER_SYNC", dedupeKey: ORDER, status: "PENDING" } });

  it("A RUNNING + B PENDING with the same key: A fails, no duplicate PENDING, B still runs", async () => {
    const shopId = await createShop();
    const enqueue = () => enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER });
    const { job: a } = await enqueue();
    let b: Awaited<ReturnType<typeof enqueue>> | undefined;

    const first = await processJobsOnce({
      limit: 1,
      execute: async () => {
        b = await enqueue(); // new request while A runs
        throw new Error("Shopify throttled");
      },
    });
    assert.deepEqual(first, { claimed: 1, succeeded: 0, retried: 0, failed: 1, leaseLost: 0 });
    assert.equal(b?.deduplicated, false);

    const pending = await pendingWithKey(shopId);
    assert.deepEqual(pending.map((row) => row.id), [b!.job.id]);
    const closed = await job(a.id);
    assert.equal(closed.status, "FAILED");
    assert.match(closed.lastError ?? "", /superseded by pending job/);

    // The remaining work is still executable.
    const executed: string[] = [];
    await processJobsOnce({ limit: 5, execute: async (claimed) => { executed.push(claimed.id); } });
    assert.deepEqual(executed, [b!.job.id]);
    assert.equal((await job(b!.job.id)).status, "SUCCEEDED");
  });

  it("without a concurrent request, a failed job with a key is retried normally", async () => {
    const shopId = await createShop();
    const { job: a } = await enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER });
    await processJobsOnce({ limit: 1, execute: async () => { throw new Error("temporary"); } });
    assert.equal((await job(a.id)).status, "PENDING");
    // A new request now deduplicates onto the retried job.
    const again = await enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER });
    assert.equal(again.deduplicated, true);
    assert.equal(again.job.id, a.id);
  });

  it("concurrent retry and enqueue never leave two PENDING jobs", async () => {
    for (let round = 0; round < 5; round += 1) {
      const shopId = await createShop();
      const enqueue = () => enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER });
      await enqueue();
      await Promise.all([
        processJobsOnce({ limit: 1, execute: async () => { throw new Error("temporary"); } }),
        enqueue(),
        enqueue(),
      ]);
      assert.equal((await pendingWithKey(shopId)).length, 1);
      await prisma.job.deleteMany({ where: { shopId } });
    }
  });

  it("PostgreSQL rejects a second PENDING job with the same key", async () => {
    const shopId = await createShop();
    await prisma.job.create({ data: { shopId, type: "CATALOG_SYNC", payload: {}, dedupeKey: "k" } });
    await assert.rejects(
      prisma.job.create({ data: { shopId, type: "CATALOG_SYNC", payload: {}, dedupeKey: "k" } }),
      /Unique constraint/,
    );
    // Other statuses and null keys are not constrained.
    await prisma.job.create({ data: { shopId, type: "CATALOG_SYNC", payload: {}, dedupeKey: "k", status: "SUCCEEDED" } });
    await prisma.job.create({ data: { shopId, type: "CATALOG_SYNC", payload: {} } });
    await prisma.job.create({ data: { shopId, type: "CATALOG_SYNC", payload: {} } });
  });
});

describe("processJobsOnce", () => {
  it("6. two workers never run the same job", async () => {
    const shopId = await createShop();
    const ids = [];
    for (let index = 0; index < 8; index += 1) {
      ids.push((await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} })).job.id);
    }
    const executed: string[] = [];
    const slow = async (claimed: ClaimedJob) => {
      executed.push(claimed.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const [a, b] = await Promise.all([processJobsOnce({ execute: slow, limit: 8 }), processJobsOnce({ execute: slow, limit: 8 })]);
    assert.equal(a.claimed + b.claimed, 8);
    assert.equal(executed.length, 8);
    assert.deepEqual([...executed].sort(), [...ids].sort());
  });

  it("7. a successful run marks the job SUCCEEDED and releases the lease", async () => {
    const shopId = await createShop();
    const { job: created } = await enqueueJob({ shopId, type: "ORDER_SYNC", payload: { orderGid: ORDER } });
    let received: ClaimedJob | undefined;
    const result = await processJobsOnce({ limit: 5, execute: async (claimed) => { received = claimed; } });
    assert.deepEqual(result, { claimed: 1, succeeded: 1, retried: 0, failed: 0, leaseLost: 0 });
    assert.equal(received?.type, "ORDER_SYNC");
    assert.deepEqual(received?.payload, { orderGid: ORDER });
    assert.equal(received?.attempts, 1);
    const done = await job(created.id);
    assert.equal(done.status, "SUCCEEDED");
    assert.ok(done.finishedAt instanceof Date);
    assert.equal(done.lockToken, null);
    assert.equal(done.lockedUntil, null);
  });

  it("8. a temporary error goes back to PENDING with a delayed runAt", async () => {
    const shopId = await createShop();
    const { job: created } = await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} });
    const result = await processJobsOnce({ limit: 5, execute: async () => { throw new Error("Shopify throttled"); } });
    assert.deepEqual(result, { claimed: 1, succeeded: 0, retried: 1, failed: 0, leaseLost: 0 });

    const retried = await job(created.id);
    assert.equal(retried.status, "PENDING");
    assert.equal(retried.attempts, 1);
    assert.equal(retried.lastError, "Error: Shopify throttled");
    const delayMs = retried.runAt.getTime() - (await dbNow()).getTime();
    assert.ok(delayMs > 55_000 && delayMs <= 60_000, `delay ${delayMs}`);
    // 15. not processed before runAt
    assert.equal((await processJobsOnce({ execute: ok, limit: 5 })).claimed, 0);
  });

  it("9. exponential backoff, then FAILED after maxAttempts", async () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(backoffMinutes), [1, 2, 4, 8, 16, 16, 16]);

    const shopId = await createShop();
    const { job: created } = await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await makeDue(created.id);
      await processJobsOnce({ limit: 1, execute: async () => { throw new Error(`fail ${attempt}`); } });
      const current = await job(created.id);
      assert.equal(current.attempts, attempt);
      if (attempt < 5) {
        assert.equal(current.status, "PENDING");
        delays.push(Math.round((current.runAt.getTime() - (await dbNow()).getTime()) / 60_000));
      } else {
        assert.equal(current.status, "FAILED");
        assert.ok(current.finishedAt instanceof Date);
        assert.equal(current.lastError, "Error: fail 5");
      }
    }
    assert.deepEqual(delays, [1, 2, 4, 8]);
  });

  it("10. a permanent error fails at once, as does an invalid stored payload", async () => {
    const shopId = await createShop();
    const { job: created } = await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} });
    const result = await processJobsOnce({ limit: 1, execute: async () => { throw new PermanentJobError("order deleted"); } });
    assert.equal(result.failed, 1);
    const failed = await job(created.id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.attempts, 1);

    const corrupted = await prisma.job.create({ data: { shopId, type: "ORDER_SYNC", payload: { orderGid: "bad" } } });
    let executed = false;
    await processJobsOnce({ limit: 1, execute: async () => { executed = true; } });
    assert.equal(executed, false);
    assert.equal((await job(corrupted.id)).status, "FAILED");
  });

  it("11. an expired RUNNING lease is claimed again; past the last attempt it fails", async () => {
    const shopId = await createShop();
    const crashed = await prisma.job.create({
      data: {
        shopId, type: "CATALOG_SYNC", payload: {}, status: "RUNNING", attempts: 1,
        lockToken: randomUUID(), lockedUntil: new Date(Date.now() - 60_000),
      },
    });
    const result = await processJobsOnce({ execute: ok, limit: 5 });
    assert.equal(result.succeeded, 1);
    const recovered = await job(crashed.id);
    assert.equal(recovered.status, "SUCCEEDED");
    assert.equal(recovered.attempts, 2);

    // A RUNNING job with a valid lease is left alone.
    await prisma.job.create({
      data: {
        shopId, type: "CATALOG_SYNC", payload: {}, status: "RUNNING", attempts: 1,
        lockToken: randomUUID(), lockedUntil: new Date(Date.now() + 600_000),
      },
    });
    assert.equal((await processJobsOnce({ execute: ok, limit: 5 })).claimed, 0);

    // Crash during the last allowed attempt: not executed again.
    const last = await prisma.job.create({
      data: {
        shopId, type: "CATALOG_SYNC", payload: {}, status: "RUNNING", attempts: 5,
        lockToken: randomUUID(), lockedUntil: new Date(Date.now() - 60_000),
      },
    });
    let executed = false;
    await processJobsOnce({ limit: 5, execute: async () => { executed = true; } });
    assert.equal(executed, false);
    const exhausted = await job(last.id);
    assert.equal(exhausted.status, "FAILED");
    assert.match(exhausted.lastError ?? "", /lease expired/);
  });

  it("12. a worker whose lease was taken over cannot finalize", async () => {
    const shopId = await createShop();
    const { job: created } = await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} });
    const newToken = randomUUID();
    let renewedWithOldToken: boolean | undefined;
    const result = await processJobsOnce({
      limit: 1,
      execute: async (claimed) => {
        // Simulates another worker that reclaimed the job after lease expiry.
        await prisma.job.update({ where: { id: claimed.id }, data: { lockToken: newToken } });
        renewedWithOldToken = await claimed.renewLease();
      },
    });
    assert.deepEqual(result, { claimed: 1, succeeded: 0, retried: 0, failed: 0, leaseLost: 1 });
    assert.equal(renewedWithOldToken, false);
    const current = await job(created.id);
    assert.equal(current.status, "RUNNING");
    assert.equal(current.lockToken, newToken);
  });

  it("13. a handler can renew its lease explicitly", async () => {
    const shopId = await createShop();
    const { job: created } = await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} });
    let before: Date | null = null;
    let afterRenew: Date | null = null;
    let renewed: boolean | undefined;
    await processJobsOnce({
      limit: 1,
      leaseMs: 1_000,
      execute: async (claimed) => {
        before = (await job(claimed.id)).lockedUntil;
        renewed = await claimed.renewLease(30 * 60_000);
        afterRenew = (await job(claimed.id)).lockedUntil;
      },
    });
    assert.equal(renewed, true);
    assert.ok(before !== null && afterRenew !== null);
    assert.ok((afterRenew as Date).getTime() - (before as Date).getTime() > 25 * 60_000);
    assert.equal((await job(created.id)).status, "SUCCEEDED");
  });

  it("14. each job runs with its own persisted shopId; lookups are tenant-scoped", async () => {
    const shopA = await createShop();
    const shopB = await createShop();
    const jobA = (await enqueueJob({ shopId: shopA, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER })).job;
    const jobB = (await enqueueJob({ shopId: shopB, type: "ORDER_SYNC", payload: { orderGid: ORDER }, dedupeKey: ORDER })).job;
    assert.notEqual(jobA.id, jobB.id, "same dedupeKey in two shops gives two jobs");

    const seen = new Map<string, string>();
    await processJobsOnce({ limit: 5, execute: async (claimed) => { seen.set(claimed.id, claimed.shopId); } });
    assert.equal(seen.get(jobA.id), shopA);
    assert.equal(seen.get(jobB.id), shopB);

    assert.equal(await findJobForShop(shopB, jobA.id), null);
    assert.equal((await findJobForShop(shopA, jobA.id))?.id, jobA.id);
  });

  it("15. a job scheduled in the future is not processed", async () => {
    const shopId = await createShop();
    await prisma.job.create({ data: { shopId, type: "CATALOG_SYNC", payload: {}, runAt: new Date(Date.now() + 3_600_000) } });
    assert.equal((await processJobsOnce({ execute: ok, limit: 5 })).claimed, 0);
  });

  it("limit bounds the number of jobs per invocation", async () => {
    const shopId = await createShop();
    for (let index = 0; index < 3; index += 1) await enqueueJob({ shopId, type: "CATALOG_SYNC", payload: {} });
    assert.equal((await processJobsOnce({ execute: ok, limit: 2 })).claimed, 2);
    assert.equal((await processJobsOnce({ execute: ok, limit: 2 })).claimed, 1);
  });

  it("lastError is redacted and truncated", () => {
    const message = sanitizeError(new Error(`token shpat_abc123 Bearer xyz.789 access_token=s3cr3t ${"x".repeat(2000)}`));
    assert.ok(!message.includes("shpat_abc123"));
    assert.ok(!message.includes("xyz.789"));
    assert.ok(!message.includes("s3cr3t"));
    assert.ok(message.length <= 1000);
  });
});
