-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- Existing records predate authenticated server-side conversations. Nullable
-- ownership fields keep the migration non-destructive; the retention worker
-- expires these legacy rows and every new write supplies full ownership.
ALTER TABLE "AiInquiry"
    ADD COLUMN "tenantId" TEXT,
    ADD COLUMN "actor" TEXT,
    ADD COLUMN "conversationId" TEXT,
    ADD COLUMN "conversationContext" JSONB,
    ADD COLUMN "entities" JSONB,
    ADD COLUMN "periodStart" TIMESTAMP(3),
    ADD COLUMN "periodEnd" TIMESTAMP(3),
    ADD COLUMN "sourceStatus" JSONB,
    ADD COLUMN "retentionUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "AiConversation_tenantId_actor_updatedAt_idx"
    ON "AiConversation"("tenantId", "actor", "updatedAt");
CREATE INDEX "AiConversation_expiresAt_idx" ON "AiConversation"("expiresAt");
CREATE INDEX "AiInquiry_tenantId_actor_conversationId_createdAt_idx"
    ON "AiInquiry"("tenantId", "actor", "conversationId", "createdAt");
CREATE INDEX "AiInquiry_retentionUntil_idx" ON "AiInquiry"("retentionUntil");

ALTER TABLE "AiConversation"
    ADD CONSTRAINT "AiConversation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiInquiry"
    ADD CONSTRAINT "AiInquiry_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiInquiry"
    ADD CONSTRAINT "AiInquiry_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
