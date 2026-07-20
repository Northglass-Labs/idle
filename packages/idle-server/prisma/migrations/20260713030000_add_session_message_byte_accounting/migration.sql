ALTER TABLE "SessionMessage"
ADD COLUMN "contentBytes" INTEGER NOT NULL DEFAULT 0;

-- Existing releases stored the standard-base64 ciphertext at content.c. Count
-- its UTF-8 bytes without attempting to decrypt or decode private data. The
-- fallback conservatively accounts for any pre-schema legacy JSON shape.
UPDATE "SessionMessage"
SET "contentBytes" = CASE
    WHEN jsonb_typeof("content" -> 'c') = 'string'
        THEN octet_length("content" ->> 'c')
    ELSE octet_length("content"::text)
END;

ALTER TABLE "SessionMessage"
ALTER COLUMN "contentBytes" DROP DEFAULT;

ALTER TABLE "SessionMessage"
ADD CONSTRAINT "SessionMessage_contentBytes_nonnegative"
CHECK ("contentBytes" >= 0);
