ALTER TABLE "PlatformThresholds" ADD COLUMN "tenantId" TEXT;

UPDATE "PlatformThresholds"
SET "tenantId" = (SELECT "id" FROM "Tenant" WHERE "slug" = 'default' LIMIT 1)
WHERE "tenantId" IS NULL;

UPDATE "PlatformThresholds"
SET "tenantId" = (SELECT "id" FROM "Tenant" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "tenantId" IS NULL;

DELETE FROM "PlatformThresholds" WHERE "tenantId" IS NULL;

ALTER TABLE "PlatformThresholds" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX IF EXISTS "PlatformThresholds_slot_key";

ALTER TABLE "PlatformThresholds" DROP COLUMN "slot";

CREATE UNIQUE INDEX "PlatformThresholds_tenantId_key" ON "PlatformThresholds"("tenantId");

ALTER TABLE "PlatformThresholds" ADD CONSTRAINT "PlatformThresholds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
