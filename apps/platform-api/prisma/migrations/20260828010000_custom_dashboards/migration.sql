CREATE TABLE "CustomDashboard" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "widgets" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomDashboard_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomDashboard_tenantId_idx" ON "CustomDashboard"("tenantId");

ALTER TABLE "CustomDashboard" ADD CONSTRAINT "CustomDashboard_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
