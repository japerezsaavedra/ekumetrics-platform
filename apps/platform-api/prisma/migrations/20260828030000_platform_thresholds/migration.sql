CREATE TABLE "PlatformThresholds" (
    "id" TEXT NOT NULL,
    "slot" TEXT NOT NULL DEFAULT 'default',
    "values" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformThresholds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformThresholds_slot_key" ON "PlatformThresholds"("slot");
