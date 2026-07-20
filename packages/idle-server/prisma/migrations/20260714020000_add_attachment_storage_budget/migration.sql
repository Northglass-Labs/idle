ALTER TABLE "AttachmentDeletion"
ADD COLUMN "size" INTEGER;

ALTER TABLE "AttachmentDeletion"
ADD CONSTRAINT "AttachmentDeletion_size_check"
CHECK ("size" IS NULL OR "size" BETWEEN 1 AND 10485760);

CREATE TABLE "AttachmentStorageBudget" (
    "id" TEXT NOT NULL,
    "accountedBytes" BIGINT NOT NULL DEFAULT 0,
    "objectCount" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentStorageBudget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AttachmentStorageBudget_accountedBytes_check"
        CHECK ("accountedBytes" >= 0),
    CONSTRAINT "AttachmentStorageBudget_objectCount_check"
        CHECK ("objectCount" >= 0)
);

-- Existing attachment rows are conservatively charged, including live
-- reservations whose object may already have been written. Legacy deletion
-- jobs have no size and were already absent from Attachment, so they remain
-- uncharged and are acknowledged without a decrement.
INSERT INTO "AttachmentStorageBudget" (
    "id",
    "accountedBytes",
    "objectCount",
    "updatedAt"
)
SELECT
    'attachments',
    COALESCE(sum("size"), 0)::bigint,
    count(*)::bigint,
    CURRENT_TIMESTAMP
FROM "Attachment";
