-- AIOps metadata on AgentEvent (no CanonicalEvent table).
-- New columns are nullable so existing collector envelopes keep working.

ALTER TABLE "AgentEvent" ADD COLUMN "category" TEXT;
ALTER TABLE "AgentEvent" ADD COLUMN "entityType" TEXT;
ALTER TABLE "AgentEvent" ADD COLUMN "correlationKey" TEXT;
ALTER TABLE "AgentEvent" ADD COLUMN "environment" TEXT;
ALTER TABLE "AgentEvent" ADD COLUMN "traceId" TEXT;
ALTER TABLE "AgentEvent" ADD COLUMN "metadata" JSONB;

CREATE INDEX "AgentEvent_tenantId_category_eventAt_idx" ON "AgentEvent"("tenantId", "category", "eventAt");
CREATE INDEX "AgentEvent_tenantId_entityType_eventAt_idx" ON "AgentEvent"("tenantId", "entityType", "eventAt");
CREATE INDEX "AgentEvent_tenantId_severity_eventAt_idx" ON "AgentEvent"("tenantId", "severity", "eventAt");
CREATE INDEX "AgentEvent_tenantId_correlationKey_eventAt_idx" ON "AgentEvent"("tenantId", "correlationKey", "eventAt");
CREATE INDEX "AgentEvent_tenantId_environment_eventAt_idx" ON "AgentEvent"("tenantId", "environment", "eventAt");
CREATE INDEX "AgentEvent_tenantId_traceId_idx" ON "AgentEvent"("tenantId", "traceId");

-- Best-effort fill for rows still in retention. Does not rewrite fingerprints.
UPDATE "AgentEvent"
SET "category" = CASE "signal"
    WHEN 'asset_discovered' THEN 'ASSET'
    WHEN 'asset_updated' THEN 'ASSET'
    WHEN 'asset_stale' THEN 'ASSET'
    WHEN 'mac_changed' THEN 'ASSET'
    WHEN 'neighbor_observed' THEN 'NEIGHBOR'
    WHEN 'flow.bytes' THEN 'FLOW'
    WHEN 'flow.new' THEN 'FLOW'
    WHEN 'snmp.trap' THEN 'TRAP'
    ELSE "category"
END
WHERE "category" IS NULL;

UPDATE "AgentEvent"
SET "entityType" = "assetType"
WHERE "entityType" IS NULL AND "assetType" IS NOT NULL;

UPDATE "AgentEvent"
SET "environment" = "tags"->>'environment'
WHERE "environment" IS NULL AND "tags" ? 'environment';

UPDATE "AgentEvent"
SET "traceId" = COALESCE("tags"->>'trace_id', "tags"->>'traceId')
WHERE "traceId" IS NULL AND ("tags" ? 'trace_id' OR "tags" ? 'traceId');
