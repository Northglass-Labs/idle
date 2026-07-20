CREATE TYPE "AttachmentTransport" AS ENUM ('DIRECT', 'RELAY');

-- Existing reservations may already have an issued S3 capability, so the safe
-- upgrade default is DIRECT: retain and charge them until their owner removes
-- them instead of guessing that an expired object cannot still arrive.
ALTER TABLE "Attachment"
ADD COLUMN "transport" "AttachmentTransport" NOT NULL DEFAULT 'DIRECT';

CREATE INDEX "Attachment_accountId_transport_status_expiresAt_idx"
ON "Attachment"("accountId", "transport", "status", "expiresAt");
