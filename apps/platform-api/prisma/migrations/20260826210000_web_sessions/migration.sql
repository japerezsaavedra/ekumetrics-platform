CREATE TABLE "WebSession" (
    "sessionHash" TEXT NOT NULL,
    "encryptedTokens" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebSession_pkey" PRIMARY KEY ("sessionHash")
);

CREATE INDEX "WebSession_expiresAt_idx" ON "WebSession"("expiresAt");
CREATE INDEX "WebSession_subject_idx" ON "WebSession"("subject");
