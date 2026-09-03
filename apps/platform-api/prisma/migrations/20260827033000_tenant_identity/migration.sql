CREATE TABLE "TenantIdentity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT false,
    "entraEnabled" BOOLEAN NOT NULL DEFAULT false,
    "entraTenantId" TEXT,
    "entraClientId" TEXT,
    "entraClientSecret" TEXT,
    "adEnabled" BOOLEAN NOT NULL DEFAULT false,
    "adConnectionUrl" TEXT,
    "adBindDn" TEXT,
    "adBindPassword" TEXT,
    "adUsersDn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantIdentity_tenantId_key" ON "TenantIdentity"("tenantId");
CREATE INDEX "TenantIdentity_tenantId_idx" ON "TenantIdentity"("tenantId");
ALTER TABLE "TenantIdentity" ADD CONSTRAINT "TenantIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
