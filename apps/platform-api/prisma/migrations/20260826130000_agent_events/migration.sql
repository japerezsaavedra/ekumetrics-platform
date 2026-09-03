-- Persistencia idempotente de envelopes enviados por Ekumetrics Agent.
ALTER TABLE "Asset" ADD COLUMN "lastObservedAt" TIMESTAMP(3);

CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "assetKey" TEXT,
    "assetType" TEXT,
    "vendor" TEXT,
    "tier" INTEGER,
    "signal" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "severity" TEXT,
    "source" TEXT NOT NULL,
    "tags" JSONB,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentEvent_fingerprint_key" ON "AgentEvent"("fingerprint");
CREATE INDEX "AgentEvent_tenantId_eventAt_idx" ON "AgentEvent"("tenantId", "eventAt");
CREATE INDEX "AgentEvent_agentId_eventAt_idx" ON "AgentEvent"("agentId", "eventAt");
CREATE INDEX "AgentEvent_signal_eventAt_idx" ON "AgentEvent"("signal", "eventAt");
CREATE INDEX "AgentEvent_assetKey_eventAt_idx" ON "AgentEvent"("assetKey", "eventAt");

ALTER TABLE "AgentEvent"
    ADD CONSTRAINT "AgentEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentEvent"
    ADD CONSTRAINT "AgentEvent_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
