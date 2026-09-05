-- AlterTable
ALTER TABLE "IncidentEnrichment" ADD COLUMN "snapshot" JSONB;

-- AlterTable
ALTER TABLE "IncidentSignature" ADD COLUMN "incidentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "AiopsEventOutbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiopsEventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiopsEventOutbox_tenantId_idempotencyKey_key" ON "AiopsEventOutbox"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AiopsEventOutbox_status_availableAt_idx" ON "AiopsEventOutbox"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AiopsEventOutbox_tenantId_status_idx" ON "AiopsEventOutbox"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "AiopsEventOutbox" ADD CONSTRAINT "AiopsEventOutbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
