-- AlterEnum
ALTER TYPE "AiopsInvestigationStatus" ADD VALUE 'PENDING';
ALTER TYPE "AiopsInvestigationStatus" ADD VALUE 'PARTIAL';
ALTER TYPE "AiopsInvestigationStatus" ADD VALUE 'TIMEOUT';

-- AlterTable
ALTER TABLE "AiopsInvestigation" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AiopsInvestigation" ADD COLUMN "skippedAgents" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AiopsInvestigation" ADD COLUMN "selectionTrace" JSONB;
ALTER TABLE "AiopsInvestigation" ADD COLUMN "privacyMode" TEXT;
ALTER TABLE "AiopsInvestigation" ADD COLUMN "investigationResult" JSONB;
ALTER TABLE "AiopsInvestigation" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "AiopsInvestigation" ADD COLUMN "errorDetail" TEXT;
ALTER TABLE "AiopsInvestigation" ADD COLUMN "correlationId" TEXT;

-- AlterTable
ALTER TABLE "AgentFinding" ADD COLUMN "skipReason" TEXT;
ALTER TABLE "AgentFinding" ADD COLUMN "plan" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "AiopsInvestigation_tenantId_incidentId_version_key" ON "AiopsInvestigation"("tenantId", "incidentId", "version");

-- CreateTable
CREATE TABLE "AiopsInvestigationPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "privacyMode" TEXT NOT NULL DEFAULT 'AI_DISABLED',
    "enabledAgentTypes" JSONB NOT NULL DEFAULT '["Rca","Metrics","Logs","Kubernetes","Topology","Synthesis"]',
    "budget" JSONB NOT NULL DEFAULT '{}',
    "holmesKubernetesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiopsInvestigationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiopsInvestigationPolicy_tenantId_key" ON "AiopsInvestigationPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "AiopsInvestigationPolicy_tenantId_idx" ON "AiopsInvestigationPolicy"("tenantId");

-- AddForeignKey
ALTER TABLE "AiopsInvestigationPolicy" ADD CONSTRAINT "AiopsInvestigationPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
