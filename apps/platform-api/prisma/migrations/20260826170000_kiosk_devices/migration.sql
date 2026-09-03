CREATE TABLE "KioskDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dashboard" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "credentialExpiresAt" TIMESTAMP(3) NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastRenewedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KioskDevice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KioskDevice_tenantId_idx" ON "KioskDevice"("tenantId");
CREATE INDEX "KioskDevice_siteId_idx" ON "KioskDevice"("siteId");
CREATE INDEX "KioskDevice_revokedAt_idx" ON "KioskDevice"("revokedAt");
ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
