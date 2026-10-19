import type { Job, JobType, Prisma } from "@prisma/client";

import prisma from "../db.server.ts";

/**
 * PG-009: persistent PostgreSQL job queue (see docs/PG-009-job-infrastructure.md).
 * No Shopify call here: the executor is injected. Handlers must be idempotent,
 * because a job can run again after a crash or an expired lease.
 */

// ---------------------------------------------------------------------------
// Job contracts
// ---------------------------------------------------------------------------

export interface JobPayloads {
  ORDER_SYNC: { orderGid: string };
  ORDER_RECONCILIATION: { updatedSince: string; updatedUntil: string };
  CATALOG_SYNC: Record<string, never>;
}

/** What an executor receives. shopId always comes from the persisted job. */
export type ClaimedJob = {
  [T in JobType]: {
    id: string;
    shopId: string;
    type: T;
    payload: JobPayloads[T];
    attempts: number;
    maxAttempts: number;
    lockToken: string;
    /** Extends the lease of a long handler. Returns false if the lease was lost. */
    renewLease: (leaseMs?: number) => Promise<boolean>;
  };
}[JobType];

export type JobExecutor = (job: ClaimedJob) => Promise<void>;

export type JobQueueErrorCode = "SHOP_NOT_FOUND" | "INVALID_JOB_TYPE" | "INVALID_JOB_PAYLOAD";

export class JobQueueError extends Error {
  readonly code: JobQueueErrorCode;

  constructor(code: JobQueueErrorCode, message: string) {
    super(message);
    this.name = "JobQueueError";
    this.code = code;
  }
}

/** Thrown by an executor to fail the job at once, without any retry. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 1000;

const JOB_TYPES: readonly JobType[] = ["ORDER_SYNC", "ORDER_RECONCILIATION", "CATALOG_SYNC"];
const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/\d+$/;

/** Exact keys only: no extra field can carry a token or a secret. */
export function validateJobPayload<T extends JobType>(type: T, payload: unknown): JobPayloads[T] {
  if (!JOB_TYPES.includes(type)) {
    throw new JobQueueError("INVALID_JOB_TYPE", `unknown job type ${String(type)}`);
  }
  const invalid = (reason: string) => new JobQueueError("INVALID_JOB_PAYLOAD", `${type}: ${reason}`);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalid("payload must be an object");
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");

  switch (type) {
    case "ORDER_SYNC": {
      if (keys !== "orderGid") throw invalid("expected exactly { orderGid }");
      if (typeof record.orderGid !== "string" || !ORDER_GID_PATTERN.test(record.orderGid)) {
        throw invalid("orderGid must be a gid://shopify/Order/<id>");
      }
      return { orderGid: record.orderGid } as JobPayloads[T];
    }
    case "ORDER_RECONCILIATION": {
      if (keys !== "updatedSince,updatedUntil") throw invalid("expected exactly { updatedSince, updatedUntil }");
      const since = isoDate(record.updatedSince);
      const until = isoDate(record.updatedUntil);
      if (since === null || until === null) throw invalid("dates must be ISO 8601 strings");
      if (since >= until) throw invalid("updatedSince must be before updatedUntil");
      return { updatedSince: record.updatedSince, updatedUntil: record.updatedUntil } as JobPayloads[T];
    }
    case "CATALOG_SYNC": {
      if (keys !== "") throw invalid("expected an empty object");
      return {} as JobPayloads[T];
    }
    default:
      throw new JobQueueError("INVALID_JOB_TYPE", `unknown job type ${String(type)}`);
  }
}

function isoDate(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  job: Job;
  /** true when an identical PENDING job already existed and was returned instead. */
  deduplicated: boolean;
}

/**
 * Creates a PENDING job. With a dedupeKey, at most one PENDING job exists per
 * (shopId, type, dedupeKey): a transaction-scoped advisory lock makes the check
 * and the insert atomic. SUCCEEDED, FAILED and RUNNING jobs never block a new one.
 */
export async function enqueueJob<T extends JobType>({
  shopId,
  type,
  payload,
  dedupeKey,
}: {
  shopId: string;
  type: T;
  payload: JobPayloads[T];
  dedupeKey?: string;
}): Promise<EnqueueResult> {
  const validPayload = validateJobPayload(type, payload) as Prisma.InputJsonObject;
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true } });
  if (shop === null) {
    throw new JobQueueError("SHOP_NOT_FOUND", `no shop ${shopId}`);
  }

  if (dedupeKey === undefined) {
    const job = await prisma.job.create({ data: { shopId, type, payload: validPayload } });
    return { job, deduplicated: false };
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`job:${shopId}:${type}:${dedupeKey}`}, 0))`;
    const existing = await tx.job.findFirst({ where: { shopId, type, dedupeKey, status: "PENDING" } });
    if (existing !== null) return { job: existing, deduplicated: true };
    const job = await tx.job.create({ data: { shopId, type, payload: validPayload, dedupeKey } });
    return { job, deduplicated: false };
  });
}

/** Tenant-scoped lookup: a job is only visible through its own shop. */
export function findJobForShop(shopId: string, jobId: string): Promise<Job | null> {
  return prisma.job.findFirst({ where: { id: jobId, shopId } });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ProcessResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  /** Jobs whose lease was taken over before finalization (result not written). */
  leaseLost: number;
}

/**
 * Claims and runs up to `limit` due jobs, one after the other.
 * Each claim is one atomic statement (FOR UPDATE SKIP LOCKED); no DB transaction
 * stays open while the executor runs.
 */
export async function processJobsOnce({
  execute,
  limit,
  leaseMs = DEFAULT_LEASE_MS,
}: {
  execute: JobExecutor;
  limit: number;
  leaseMs?: number;
}): Promise<ProcessResult> {
  const result: ProcessResult = { claimed: 0, succeeded: 0, retried: 0, failed: 0, leaseLost: 0 };

  for (let index = 0; index < limit; index += 1) {
    const job = await claimNextJob(leaseMs);
    if (job === null) break;
    result.claimed += 1;
    const lockToken = job.lockToken as string;

    // Crash after the last attempt: the expired lease is reclaimed but not run again.
    if (job.attempts > job.maxAttempts) {
      const done = await finishFailed(job.id, lockToken, "lease expired after the last attempt");
      result[done ? "failed" : "leaseLost"] += 1;
      continue;
    }

    let outcome: "succeeded" | "retried" | "failed";
    let written: boolean;
    try {
      const payload = validateJobPayload(job.type, job.payload);
      await execute({
        id: job.id,
        shopId: job.shopId,
        type: job.type,
        payload,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        lockToken,
        renewLease: (ms = leaseMs) => renewLease(job.id, lockToken, ms),
      } as ClaimedJob);
      outcome = "succeeded";
      written = await finishSucceeded(job.id, lockToken);
    } catch (error) {
      const message = sanitizeError(error);
      const permanent = error instanceof PermanentJobError || error instanceof JobQueueError;
      if (permanent || job.attempts >= job.maxAttempts) {
        outcome = "failed";
        written = await finishFailed(job.id, lockToken, message);
      } else {
        const retry = await scheduleRetry(job, lockToken, message, backoffMinutes(job.attempts));
        outcome = retry === "superseded" ? "failed" : "retried";
        written = retry !== "lost";
      }
    }
    result[written ? outcome : "leaseLost"] += 1;
  }
  return result;
}

/** 1, 2, 4, 8, then 16 minutes (cap). `attempts` is the attempt that just failed. */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0), 16);
}

/**
 * Atomically claims the oldest due job: a PENDING job whose runAt has passed,
 * or a RUNNING job whose lease expired. Uses the database clock.
 */
async function claimNextJob(leaseMs: number): Promise<Job | null> {
  const rows = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
    SET "status" = 'RUNNING',
        "attempts" = "attempts" + 1,
        "lockToken" = gen_random_uuid(),
        "lockedUntil" = now() + ${leaseMs}::integer * interval '1 millisecond',
        "updatedAt" = now()
    WHERE "id" = (
      SELECT "id" FROM "Job"
      WHERE ("status" = 'PENDING' AND "runAt" <= now())
         OR ("status" = 'RUNNING' AND "lockedUntil" < now())
      ORDER BY "runAt" ASC, "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  return rows[0] ?? null;
}

/** Every finalization requires the current lockToken: a stale worker writes nothing. */
async function finishSucceeded(id: string, lockToken: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "Job"
    SET "status" = 'SUCCEEDED', "finishedAt" = now(), "lockToken" = NULL, "lockedUntil" = NULL,
        "lastError" = NULL, "updatedAt" = now()
    WHERE "id" = ${id}::uuid AND "lockToken" = ${lockToken}::uuid AND "status" = 'RUNNING'`;
  return count === 1;
}

async function finishFailed(id: string, lockToken: string, lastError: string): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "Job"
    SET "status" = 'FAILED', "finishedAt" = now(), "lockToken" = NULL, "lockedUntil" = NULL,
        "lastError" = ${lastError}, "updatedAt" = now()
    WHERE "id" = ${id}::uuid AND "lockToken" = ${lockToken}::uuid AND "status" = 'RUNNING'`;
  return count === 1;
}

/**
 * Puts a failed job back to PENDING. With a dedupeKey, PostgreSQL forbids a second
 * PENDING job for (shopId, type, dedupeKey) (partial unique index). If another PENDING
 * job with the same key was enqueued meanwhile, it already carries the requested work:
 * this attempt is closed as FAILED ("superseded") and the PENDING job stays executable.
 * The enqueue advisory lock serializes this check with concurrent enqueues.
 */
async function scheduleRetry(
  job: Job,
  lockToken: string,
  lastError: string,
  minutes: number,
): Promise<"retried" | "superseded" | "lost"> {
  const retry = (tx: Prisma.TransactionClient | typeof prisma) => tx.$executeRaw`
    UPDATE "Job"
    SET "status" = 'PENDING', "runAt" = now() + ${minutes}::integer * interval '1 minute',
        "lockToken" = NULL, "lockedUntil" = NULL, "lastError" = ${lastError}, "updatedAt" = now()
    WHERE "id" = ${job.id}::uuid AND "lockToken" = ${lockToken}::uuid AND "status" = 'RUNNING'`;

  if (job.dedupeKey === null) {
    return (await retry(prisma)) === 1 ? "retried" : "lost";
  }
  const dedupeKey = job.dedupeKey;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`job:${job.shopId}:${job.type}:${dedupeKey}`}, 0))`;
    const pending = await tx.job.findFirst({
      where: { shopId: job.shopId, type: job.type, dedupeKey, status: "PENDING", id: { not: job.id } },
      select: { id: true },
    });
    if (pending === null) {
      return (await retry(tx)) === 1 ? "retried" : "lost";
    }
    const superseded = `${lastError} (retry superseded by pending job ${pending.id})`;
    const count = await tx.$executeRaw`
      UPDATE "Job"
      SET "status" = 'FAILED', "finishedAt" = now(), "lockToken" = NULL, "lockedUntil" = NULL,
          "lastError" = ${superseded.slice(0, MAX_ERROR_LENGTH)}, "updatedAt" = now()
      WHERE "id" = ${job.id}::uuid AND "lockToken" = ${lockToken}::uuid AND "status" = 'RUNNING'`;
    return count === 1 ? "superseded" : "lost";
  });
}

/** Explicit lease renewal for long handlers. No timer: the handler calls it. */
export async function renewLease(id: string, lockToken: string, leaseMs: number = DEFAULT_LEASE_MS): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "Job"
    SET "lockedUntil" = now() + ${leaseMs}::integer * interval '1 millisecond', "updatedAt" = now()
    WHERE "id" = ${id}::uuid AND "lockToken" = ${lockToken}::uuid AND "status" = 'RUNNING'`;
  return count === 1;
}

/** Short, redacted error text: no Shopify token or bearer secret is stored. */
export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const redacted = raw
    .replace(/shp(at|ss|ca|pa|ua)_[A-Za-z0-9]+/g, "shp$1_[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(access[_-]?token["'=:\s]+)[^\s"',}]+/gi, "$1[REDACTED]");
  return redacted.length > MAX_ERROR_LENGTH ? `${redacted.slice(0, MAX_ERROR_LENGTH - 1)}…` : redacted;
}
