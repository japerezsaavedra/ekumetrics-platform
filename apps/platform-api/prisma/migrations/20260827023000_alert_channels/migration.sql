CREATE TABLE "AlertChannel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severities" TEXT[] NOT NULL,
    "configEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlertChannel_tenantId_name_key" ON "AlertChannel"("tenantId", "name");
CREATE INDEX "AlertChannel_tenantId_idx" ON "AlertChannel"("tenantId");
ALTER TABLE "AlertChannel" ADD CONSTRAINT "AlertChannel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
