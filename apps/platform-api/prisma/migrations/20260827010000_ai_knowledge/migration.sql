CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "AiKnowledgeDocument" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "sourceKey" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "component" TEXT,
  "checksum" TEXT NOT NULL,
  "approvedBy" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validUntil" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiKnowledgeDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiKnowledgeDocument_sourceType_check"
    CHECK ("sourceType" IN ('product', 'runbook', 'postmortem')),
  CONSTRAINT "AiKnowledgeDocument_validity_check"
    CHECK ("validUntil" IS NULL OR "validUntil" > "validFrom")
);

CREATE TABLE "AiKnowledgeChunk" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "heading" TEXT,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "tokenCount" INTEGER NOT NULL,
  "embeddingModel" TEXT,
  "embedding" vector(1024),
  "searchVector" tsvector GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce("heading", '') || ' ' || "content")
  ) STORED,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiKnowledgeChunk_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiKnowledgeChunk_tokenCount_check" CHECK ("tokenCount" > 0)
);

CREATE UNIQUE INDEX "AiKnowledgeDocument_scope_source_key"
  ON "AiKnowledgeDocument" (coalesce("tenantId", '__global__'), "sourceKey");
CREATE INDEX "AiKnowledgeDocument_scope_type_component_idx"
  ON "AiKnowledgeDocument" ("tenantId", "sourceType", "component");
CREATE INDEX "AiKnowledgeDocument_validity_idx"
  ON "AiKnowledgeDocument" ("validFrom", "validUntil", "deletedAt");
CREATE UNIQUE INDEX "AiKnowledgeChunk_documentId_ordinal_key"
  ON "AiKnowledgeChunk" ("documentId", "ordinal");
CREATE INDEX "AiKnowledgeChunk_documentId_idx" ON "AiKnowledgeChunk" ("documentId");
CREATE INDEX "AiKnowledgeChunk_search_idx" ON "AiKnowledgeChunk" USING GIN ("searchVector");
CREATE INDEX "AiKnowledgeChunk_embedding_idx" ON "AiKnowledgeChunk"
  USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);

ALTER TABLE "AiKnowledgeDocument"
  ADD CONSTRAINT "AiKnowledgeDocument_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiKnowledgeChunk"
  ADD CONSTRAINT "AiKnowledgeChunk_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "AiKnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
