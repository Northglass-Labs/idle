CREATE TABLE "AttachmentDeletion" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentDeletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttachmentDeletion_ref_key" ON "AttachmentDeletion"("ref");
CREATE INDEX "AttachmentDeletion_createdAt_id_idx" ON "AttachmentDeletion"("createdAt", "id");
