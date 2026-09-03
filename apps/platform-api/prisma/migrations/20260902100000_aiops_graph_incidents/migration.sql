ALTER TABLE "Incident" ADD COLUMN "siteId" TEXT;
ALTER TABLE "Incident" ADD COLUMN "clusterKey" TEXT;
ALTER TABLE "Incident" ADD COLUMN "causeKey" TEXT;
ALTER TABLE "Incident" ADD COLUMN "causeName" TEXT;
ALTER TABLE "Incident" ADD COLUMN "confidence" DOUBLE PRECISION;
ALTER TABLE "Incident" ADD COLUMN "windowStart" TIMESTAMP(3);
ALTER TABLE "Incident" ADD COLUMN "windowEnd" TIMESTAMP(3);
ALTER TABLE "Incident" ADD COLUMN "alertCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Incident" ADD COLUMN "eventCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Incident" ADD COLUMN "members" JSONB;

CREATE INDEX "Incident_tenantId_clusterKey_idx" ON "Incident"("tenantId", "clusterKey");
CREATE INDEX "Incident_siteId_idx" ON "Incident"("siteId");

CREATE TABLE "GraphNode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GraphEdge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "fromKey" TEXT NOT NULL,
    "toKey" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GraphNode_tenantId_nodeKey_key" ON "GraphNode"("tenantId", "nodeKey");
CREATE INDEX "GraphNode_tenantId_siteId_idx" ON "GraphNode"("tenantId", "siteId");
CREATE INDEX "GraphNode_tenantId_lastSeenAt_idx" ON "GraphNode"("tenantId", "lastSeenAt");

CREATE UNIQUE INDEX "GraphEdge_tenantId_fromKey_toKey_relation_source_key" ON "GraphEdge"("tenantId", "fromKey", "toKey", "relation", "source");
CREATE INDEX "GraphEdge_tenantId_siteId_idx" ON "GraphEdge"("tenantId", "siteId");
CREATE INDEX "GraphEdge_tenantId_fromKey_idx" ON "GraphEdge"("tenantId", "fromKey");
CREATE INDEX "GraphEdge_tenantId_toKey_idx" ON "GraphEdge"("tenantId", "toKey");

ALTER TABLE "GraphNode" ADD CONSTRAINT "GraphNode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
