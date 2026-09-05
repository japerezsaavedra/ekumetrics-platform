-- AlterTable
ALTER TABLE "GraphEdge" ADD COLUMN "confidence" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "GraphNode_tenantId_kind_idx" ON "GraphNode"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "GraphEdge_tenantId_relation_idx" ON "GraphEdge"("tenantId", "relation");
