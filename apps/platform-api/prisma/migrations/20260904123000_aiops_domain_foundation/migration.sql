-- CreateEnum
CREATE TYPE "AgentFindingStatus" AS ENUM ('PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'SKIPPED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "AiopsInvestigationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SYNTHESIZING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BUDGET_EXCEEDED');

-- CreateEnum
CREATE TYPE "IncidentLifecycle" AS ENUM ('DETECTED', 'CORRELATING', 'INVESTIGATING', 'ROOT_CAUSE_IDENTIFIED', 'MITIGATING', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "AiopsInvestigation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "status" "AiopsInvestigationStatus" NOT NULL DEFAULT 'QUEUED',
    "incidentLifecycle" "IncidentLifecycle",
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "selectedAgents" JSONB NOT NULL DEFAULT '[]',
    "budget" JSONB NOT NULL DEFAULT '{}',
    "budgetUsed" JSONB,
    "synthesisSummary" TEXT,
    "synthesisEvidence" JSONB,
    "primaryFindingId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiopsInvestigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "investigationId" TEXT,
    "agentType" TEXT NOT NULL,
    "status" "AgentFindingStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "provider" TEXT,
    "model" TEXT,
    "toolCalls" JSONB,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiopsInvestigation_tenantId_incidentId_createdAt_idx" ON "AiopsInvestigation"("tenantId", "incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "AiopsInvestigation_tenantId_status_idx" ON "AiopsInvestigation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AiopsInvestigation_tenantId_idx" ON "AiopsInvestigation"("tenantId");

-- CreateIndex
CREATE INDEX "AgentFinding_tenantId_incidentId_agentType_idx" ON "AgentFinding"("tenantId", "incidentId", "agentType");

-- CreateIndex
CREATE INDEX "AgentFinding_tenantId_investigationId_idx" ON "AgentFinding"("tenantId", "investigationId");

-- CreateIndex
CREATE INDEX "AgentFinding_tenantId_status_updatedAt_idx" ON "AgentFinding"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentFinding_tenantId_incidentId_createdAt_idx" ON "AgentFinding"("tenantId", "incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentFinding_tenantId_idx" ON "AgentFinding"("tenantId");

-- AddForeignKey
ALTER TABLE "AiopsInvestigation" ADD CONSTRAINT "AiopsInvestigation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFinding" ADD CONSTRAINT "AgentFinding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFinding" ADD CONSTRAINT "AgentFinding_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "AiopsInvestigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
