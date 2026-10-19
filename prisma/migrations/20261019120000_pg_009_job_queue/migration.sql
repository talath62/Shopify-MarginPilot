-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('ORDER_SYNC', 'ORDER_RECONCILIATION', 'CATALOG_SYNC');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopId" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMPTZ(3),
    "lockToken" UUID,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_shopId_type_dedupeKey_status_idx" ON "Job"("shopId", "type", "dedupeKey", "status");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- PG-009: CHECK constraints written by hand (Prisma does not model CHECK constraints).

-- AddCheckConstraint
ALTER TABLE "Job" ADD CONSTRAINT "Job_attempts_check"
    CHECK ("attempts" >= 0 AND "maxAttempts" >= 1);

-- AddCheckConstraint: a lease exists if and only if the job is RUNNING.
ALTER TABLE "Job" ADD CONSTRAINT "Job_lease_check"
    CHECK (("status" = 'RUNNING') = ("lockToken" IS NOT NULL AND "lockedUntil" IS NOT NULL));

-- At most one PENDING job per (shopId, type, dedupeKey). Partial unique index,
-- written by hand (not expressible in the Prisma schema). Enforced for enqueue and retry.
CREATE UNIQUE INDEX "Job_pending_dedupeKey_key"
    ON "Job"("shopId", "type", "dedupeKey")
    WHERE "status" = 'PENDING' AND "dedupeKey" IS NOT NULL;
