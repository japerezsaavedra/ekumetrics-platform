ALTER TABLE "CustomDashboard" ADD COLUMN "siteId" TEXT;

CREATE INDEX "CustomDashboard_siteId_idx" ON "CustomDashboard"("siteId");

ALTER TABLE "CustomDashboard" ADD CONSTRAINT "CustomDashboard_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
