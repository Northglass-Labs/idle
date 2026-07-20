-- Case-insensitive filesystems collapse case-distinct storage paths. Preserve
-- a lone legacy mixed-case identifier, but refuse any database identity that
-- could alias it and require canonical lowercase spelling for new rows.
CREATE UNIQUE INDEX "Session_id_casefold_key"
ON "Session" (lower("id"));

CREATE UNIQUE INDEX "Attachment_id_casefold_key"
ON "Attachment" (lower("id"));

CREATE UNIQUE INDEX "Attachment_ref_casefold_key"
ON "Attachment" (lower("ref"));

ALTER TABLE "Session"
ADD CONSTRAINT "Session_id_lowercase_check"
CHECK ("id" = lower("id")) NOT VALID;

ALTER TABLE "Attachment"
ADD CONSTRAINT "Attachment_id_lowercase_check"
CHECK ("id" = lower("id")) NOT VALID;
