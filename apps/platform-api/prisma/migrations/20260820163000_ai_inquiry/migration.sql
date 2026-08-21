-- CreateTable
CREATE TABLE "AiInquiry" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "analysis" TEXT NOT NULL,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiInquiry_createdAt_idx" ON "AiInquiry"("createdAt");

-- CreateIndex
CREATE INDEX "AiInquiry_provider_idx" ON "AiInquiry"("provider");
