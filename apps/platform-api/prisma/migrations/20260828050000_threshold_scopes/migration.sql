ALTER TABLE "PlatformThresholds" ADD COLUMN "slot" TEXT;

UPDATE "PlatformThresholds"
SET "slot" = 'agents:' || "tenantId"
WHERE "slot" IS NULL;

ALTER TABLE "PlatformThresholds" ALTER COLUMN "slot" SET NOT NULL;

CREATE UNIQUE INDEX "PlatformThresholds_slot_key" ON "PlatformThresholds"("slot");

ALTER TABLE "PlatformThresholds" DROP CONSTRAINT IF EXISTS "PlatformThresholds_tenantId_key";
DROP INDEX IF EXISTS "PlatformThresholds_tenantId_key";

ALTER TABLE "PlatformThresholds" ALTER COLUMN "tenantId" DROP NOT NULL;

INSERT INTO "PlatformThresholds" ("id", "slot", "tenantId", "values", "createdAt", "updatedAt")
SELECT
  'platform-thresholds-default',
  'platform',
  NULL,
  "values",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "PlatformThresholds"
WHERE "slot" = 'agents:' || (SELECT "id" FROM "Tenant" WHERE "slug" = 'default' LIMIT 1)
LIMIT 1
ON CONFLICT ("slot") DO NOTHING;

CREATE INDEX "PlatformThresholds_tenantId_idx" ON "PlatformThresholds"("tenantId");
