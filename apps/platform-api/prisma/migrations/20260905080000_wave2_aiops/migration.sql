-- CreateEnum
CREATE TYPE "RcaFeedbackAction" AS ENUM ('CONFIRM', 'REJECT', 'SELECT_ALTERNATIVE', 'ADD_NOTE');

-- CreateTable
CREATE TABLE "AiopsAnomaly" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metricName" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "actualValue" DOUBLE PRECISION NOT NULL,
    "expectedValue" DOUBLE PRECISION,
    "deviation" DOUBLE PRECISION,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "algorithm" TEXT NOT NULL,
    "window" TEXT,
    "metadata" JSONB,
    "incidentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiopsAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiopsAnomalyPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "metric" TEXT,
    "environment" TEXT,
    "detectorType" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "platformThresholdsId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiopsAnomalyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentEnrichment" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "primaryRootCause" TEXT,
    "rcaConfidence" DOUBLE PRECISION,
    "affectedServiceCount" INTEGER,
    "affectedEntities" JSONB,
    "affectedServices" JSONB,
    "blastRadius" JSONB,
    "topologyEvidence" JSONB,
    "anomalies" JSONB,
    "rootCauseCandidates" JSONB,
    "correlationEvidence" JSONB,
    "timeline" JSONB,
    "recentChanges" JSONB,
    "historicalMatches" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentEnrichment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentSignature" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'v1',
    "entityTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceKey" TEXT,
    "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "anomalyTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topologyPattern" TEXT,
    "environment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResolutionRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "signatureId" TEXT,
    "confirmedRootCause" TEXT,
    "rejectedRootCauses" JSONB,
    "resolution" TEXT,
    "successfulAction" TEXT,
    "timeToDetectMs" INTEGER,
    "timeToResolveMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResolutionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RcaFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "action" "RcaFeedbackAction" NOT NULL,
    "selectedEntityId" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RcaFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RcaScoringPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT '',
    "temporalWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.20,
    "topologyWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "anomalyWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.20,
    "dependencyWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "historicalWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "hops" INTEGER NOT NULL DEFAULT 8,
    "suppressionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minTopologyConfidence" DOUBLE PRECISION,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RcaScoringPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiopsAnomaly_tenantId_timestamp_idx" ON "AiopsAnomaly"("tenantId", "timestamp");

-- CreateIndex
CREATE INDEX "AiopsAnomaly_tenantId_entityId_metricName_timestamp_idx" ON "AiopsAnomaly"("tenantId", "entityId", "metricName", "timestamp");

-- CreateIndex
CREATE INDEX "AiopsAnomaly_tenantId_incidentId_idx" ON "AiopsAnomaly"("tenantId", "incidentId");

-- CreateIndex
CREATE INDEX "AiopsAnomalyPolicy_tenantId_enabled_idx" ON "AiopsAnomalyPolicy"("tenantId", "enabled");

-- CreateIndex
CREATE INDEX "AiopsAnomalyPolicy_tenantId_entityId_metric_idx" ON "AiopsAnomalyPolicy"("tenantId", "entityId", "metric");

-- CreateIndex
CREATE INDEX "AiopsAnomalyPolicy_tenantId_entityType_metric_idx" ON "AiopsAnomalyPolicy"("tenantId", "entityType", "metric");

-- CreateIndex
CREATE INDEX "AiopsAnomalyPolicy_tenantId_siteId_idx" ON "AiopsAnomalyPolicy"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "AiopsAnomalyPolicy_tenantId_detectorType_enabled_idx" ON "AiopsAnomalyPolicy"("tenantId", "detectorType", "enabled");

-- CreateIndex
CREATE INDEX "AiopsAnomalyPolicy_platformThresholdsId_idx" ON "AiopsAnomalyPolicy"("platformThresholdsId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentEnrichment_incidentId_key" ON "IncidentEnrichment"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentEnrichment_tenantId_incidentId_key" ON "IncidentEnrichment"("tenantId", "incidentId");

-- CreateIndex
CREATE INDEX "IncidentEnrichment_tenantId_idx" ON "IncidentEnrichment"("tenantId");

-- CreateIndex
CREATE INDEX "IncidentEnrichment_tenantId_rcaConfidence_idx" ON "IncidentEnrichment"("tenantId", "rcaConfidence");

-- CreateIndex
CREATE INDEX "IncidentEnrichment_tenantId_primaryRootCause_idx" ON "IncidentEnrichment"("tenantId", "primaryRootCause");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentSignature_tenantId_hash_key" ON "IncidentSignature"("tenantId", "hash");

-- CreateIndex
CREATE INDEX "IncidentSignature_tenantId_serviceKey_idx" ON "IncidentSignature"("tenantId", "serviceKey");

-- CreateIndex
CREATE INDEX "IncidentSignature_tenantId_environment_idx" ON "IncidentSignature"("tenantId", "environment");

-- CreateIndex
CREATE INDEX "IncidentSignature_tenantId_topologyPattern_idx" ON "IncidentSignature"("tenantId", "topologyPattern");

-- CreateIndex
CREATE INDEX "IncidentSignature_tenantId_createdAt_idx" ON "IncidentSignature"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ResolutionRecord_tenantId_incidentId_idx" ON "ResolutionRecord"("tenantId", "incidentId");

-- CreateIndex
CREATE INDEX "ResolutionRecord_tenantId_signatureId_idx" ON "ResolutionRecord"("tenantId", "signatureId");

-- CreateIndex
CREATE INDEX "ResolutionRecord_tenantId_createdAt_idx" ON "ResolutionRecord"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RcaFeedback_tenantId_incidentId_idx" ON "RcaFeedback"("tenantId", "incidentId");

-- CreateIndex
CREATE INDEX "RcaFeedback_tenantId_idx" ON "RcaFeedback"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RcaScoringPolicy_tenantId_environment_key" ON "RcaScoringPolicy"("tenantId", "environment");

-- CreateIndex
CREATE INDEX "RcaScoringPolicy_tenantId_idx" ON "RcaScoringPolicy"("tenantId");

-- AddForeignKey
ALTER TABLE "AiopsAnomaly" ADD CONSTRAINT "AiopsAnomaly_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiopsAnomaly" ADD CONSTRAINT "AiopsAnomaly_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiopsAnomalyPolicy" ADD CONSTRAINT "AiopsAnomalyPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiopsAnomalyPolicy" ADD CONSTRAINT "AiopsAnomalyPolicy_platformThresholdsId_fkey" FOREIGN KEY ("platformThresholdsId") REFERENCES "PlatformThresholds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEnrichment" ADD CONSTRAINT "IncidentEnrichment_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEnrichment" ADD CONSTRAINT "IncidentEnrichment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentSignature" ADD CONSTRAINT "IncidentSignature_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionRecord" ADD CONSTRAINT "ResolutionRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionRecord" ADD CONSTRAINT "ResolutionRecord_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResolutionRecord" ADD CONSTRAINT "ResolutionRecord_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "IncidentSignature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RcaFeedback" ADD CONSTRAINT "RcaFeedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RcaFeedback" ADD CONSTRAINT "RcaFeedback_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RcaScoringPolicy" ADD CONSTRAINT "RcaScoringPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
