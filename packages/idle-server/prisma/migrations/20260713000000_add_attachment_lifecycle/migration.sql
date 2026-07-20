CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING', 'WRITING', 'UPLOADED');

CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Attachment_ref_key" ON "Attachment"("ref");
CREATE INDEX "Attachment_accountId_status_expiresAt_idx" ON "Attachment"("accountId", "status", "expiresAt");
CREATE INDEX "Attachment_sessionId_status_expiresAt_idx" ON "Attachment"("sessionId", "status", "expiresAt");

ALTER TABLE "Attachment"
ADD CONSTRAINT "Attachment_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Attachment"
ADD CONSTRAINT "Attachment_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
