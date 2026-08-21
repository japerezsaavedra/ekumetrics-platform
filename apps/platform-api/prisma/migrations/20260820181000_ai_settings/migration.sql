-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL DEFAULT 'default',
    "service" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "apiKey" TEXT,
    "baseUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSettings_slot_key" ON "AiSettings"("slot");

-- CreateIndex
CREATE INDEX "AiSettings_slot_idx" ON "AiSettings"("slot");
