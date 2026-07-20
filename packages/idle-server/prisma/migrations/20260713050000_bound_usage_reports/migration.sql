-- Usage reporting is one fixed, bounded snapshot per retained session. Remove
-- legacy sessionless, cross-account, arbitrary-key, oversized, and malformed
-- rows before making the invariant durable.
DELETE FROM "UsageReport" AS report
WHERE report."sessionId" IS NULL
   OR report."key" <> 'claude-session'
   OR NOT EXISTS (
       SELECT 1
       FROM "Session" AS session
       WHERE session."id" = report."sessionId"
         AND session."accountId" = report."accountId"
   );

DELETE FROM "UsageReport"
WHERE octet_length("data"::text) > 1024;

DELETE FROM "UsageReport"
WHERE jsonb_typeof("data") IS DISTINCT FROM 'object'
   OR NOT ("data" ?& ARRAY['tokens', 'cost']::text[])
   OR ("data" - ARRAY['tokens', 'cost']::text[]) <> '{}'::jsonb
   OR jsonb_typeof("data" -> 'tokens') IS DISTINCT FROM 'object'
   OR NOT (("data" -> 'tokens') ?& ARRAY['total', 'input', 'output', 'cache_creation', 'cache_read']::text[])
   OR (("data" -> 'tokens') - ARRAY['total', 'input', 'output', 'cache_creation', 'cache_read']::text[]) <> '{}'::jsonb
   OR jsonb_typeof("data" -> 'tokens' -> 'total') IS DISTINCT FROM 'number'
   OR jsonb_typeof("data" -> 'tokens' -> 'input') IS DISTINCT FROM 'number'
   OR jsonb_typeof("data" -> 'tokens' -> 'output') IS DISTINCT FROM 'number'
   OR jsonb_typeof("data" -> 'tokens' -> 'cache_creation') IS DISTINCT FROM 'number'
   OR jsonb_typeof("data" -> 'tokens' -> 'cache_read') IS DISTINCT FROM 'number'
   OR jsonb_typeof("data" -> 'cost') IS DISTINCT FROM 'object'
   OR NOT (("data" -> 'cost') ?& ARRAY['total', 'input', 'output']::text[])
   OR (("data" -> 'cost') - ARRAY['total', 'input', 'output']::text[]) <> '{}'::jsonb
   OR jsonb_typeof("data" -> 'cost' -> 'total') IS DISTINCT FROM 'number'
   OR jsonb_typeof("data" -> 'cost' -> 'input') IS DISTINCT FROM 'number'
   OR jsonb_typeof("data" -> 'cost' -> 'output') IS DISTINCT FROM 'number';

DELETE FROM "UsageReport"
WHERE ("data" -> 'tokens' ->> 'total')::numeric NOT BETWEEN 0 AND 1000000000
   OR trunc(("data" -> 'tokens' ->> 'total')::numeric) <> ("data" -> 'tokens' ->> 'total')::numeric
   OR ("data" -> 'tokens' ->> 'input')::numeric NOT BETWEEN 0 AND 1000000000
   OR trunc(("data" -> 'tokens' ->> 'input')::numeric) <> ("data" -> 'tokens' ->> 'input')::numeric
   OR ("data" -> 'tokens' ->> 'output')::numeric NOT BETWEEN 0 AND 1000000000
   OR trunc(("data" -> 'tokens' ->> 'output')::numeric) <> ("data" -> 'tokens' ->> 'output')::numeric
   OR ("data" -> 'tokens' ->> 'cache_creation')::numeric NOT BETWEEN 0 AND 1000000000
   OR trunc(("data" -> 'tokens' ->> 'cache_creation')::numeric) <> ("data" -> 'tokens' ->> 'cache_creation')::numeric
   OR ("data" -> 'tokens' ->> 'cache_read')::numeric NOT BETWEEN 0 AND 1000000000
   OR trunc(("data" -> 'tokens' ->> 'cache_read')::numeric) <> ("data" -> 'tokens' ->> 'cache_read')::numeric
   OR ("data" -> 'tokens' ->> 'total')::numeric <>
      ("data" -> 'tokens' ->> 'input')::numeric
      + ("data" -> 'tokens' ->> 'output')::numeric
      + ("data" -> 'tokens' ->> 'cache_creation')::numeric
      + ("data" -> 'tokens' ->> 'cache_read')::numeric
   OR ("data" -> 'cost' ->> 'total')::numeric NOT BETWEEN 0 AND 1000000
   OR ("data" -> 'cost' ->> 'input')::numeric NOT BETWEEN 0 AND 1000000
   OR ("data" -> 'cost' ->> 'output')::numeric NOT BETWEEN 0 AND 1000000;

ALTER TABLE "UsageReport" DROP CONSTRAINT "UsageReport_sessionId_fkey";
ALTER TABLE "UsageReport" ALTER COLUMN "sessionId" SET NOT NULL;

CREATE UNIQUE INDEX "Session_id_accountId_key" ON "Session"("id", "accountId");
DROP INDEX "UsageReport_accountId_sessionId_key_key";
DROP INDEX "UsageReport_sessionId_idx";
CREATE UNIQUE INDEX "UsageReport_sessionId_key" ON "UsageReport"("sessionId");

ALTER TABLE "UsageReport"
ADD CONSTRAINT "UsageReport_sessionId_accountId_fkey"
FOREIGN KEY ("sessionId", "accountId") REFERENCES "Session"("id", "accountId")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageReport"
ADD CONSTRAINT "UsageReport_key_check"
CHECK ("key" = 'claude-session');

ALTER TABLE "UsageReport"
ADD CONSTRAINT "UsageReport_data_bytes_check"
CHECK (octet_length("data"::text) <= 1024);

ALTER TABLE "UsageReport"
ADD CONSTRAINT "UsageReport_data_check"
CHECK (
    CASE WHEN
        jsonb_typeof("data") = 'object'
        AND "data" ?& ARRAY['tokens', 'cost']::text[]
        AND ("data" - ARRAY['tokens', 'cost']::text[]) = '{}'::jsonb
        AND jsonb_typeof("data" -> 'tokens') = 'object'
        AND ("data" -> 'tokens') ?& ARRAY['total', 'input', 'output', 'cache_creation', 'cache_read']::text[]
        AND (("data" -> 'tokens') - ARRAY['total', 'input', 'output', 'cache_creation', 'cache_read']::text[]) = '{}'::jsonb
        AND jsonb_typeof("data" -> 'tokens' -> 'total') = 'number'
        AND jsonb_typeof("data" -> 'tokens' -> 'input') = 'number'
        AND jsonb_typeof("data" -> 'tokens' -> 'output') = 'number'
        AND jsonb_typeof("data" -> 'tokens' -> 'cache_creation') = 'number'
        AND jsonb_typeof("data" -> 'tokens' -> 'cache_read') = 'number'
        AND jsonb_typeof("data" -> 'cost') = 'object'
        AND ("data" -> 'cost') ?& ARRAY['total', 'input', 'output']::text[]
        AND (("data" -> 'cost') - ARRAY['total', 'input', 'output']::text[]) = '{}'::jsonb
        AND jsonb_typeof("data" -> 'cost' -> 'total') = 'number'
        AND jsonb_typeof("data" -> 'cost' -> 'input') = 'number'
        AND jsonb_typeof("data" -> 'cost' -> 'output') = 'number'
    THEN
        ("data" -> 'tokens' ->> 'total')::numeric BETWEEN 0 AND 1000000000
        AND trunc(("data" -> 'tokens' ->> 'total')::numeric) = ("data" -> 'tokens' ->> 'total')::numeric
        AND ("data" -> 'tokens' ->> 'input')::numeric BETWEEN 0 AND 1000000000
        AND trunc(("data" -> 'tokens' ->> 'input')::numeric) = ("data" -> 'tokens' ->> 'input')::numeric
        AND ("data" -> 'tokens' ->> 'output')::numeric BETWEEN 0 AND 1000000000
        AND trunc(("data" -> 'tokens' ->> 'output')::numeric) = ("data" -> 'tokens' ->> 'output')::numeric
        AND ("data" -> 'tokens' ->> 'cache_creation')::numeric BETWEEN 0 AND 1000000000
        AND trunc(("data" -> 'tokens' ->> 'cache_creation')::numeric) = ("data" -> 'tokens' ->> 'cache_creation')::numeric
        AND ("data" -> 'tokens' ->> 'cache_read')::numeric BETWEEN 0 AND 1000000000
        AND trunc(("data" -> 'tokens' ->> 'cache_read')::numeric) = ("data" -> 'tokens' ->> 'cache_read')::numeric
        AND ("data" -> 'tokens' ->> 'total')::numeric =
            ("data" -> 'tokens' ->> 'input')::numeric
            + ("data" -> 'tokens' ->> 'output')::numeric
            + ("data" -> 'tokens' ->> 'cache_creation')::numeric
            + ("data" -> 'tokens' ->> 'cache_read')::numeric
        AND ("data" -> 'cost' ->> 'total')::numeric BETWEEN 0 AND 1000000
        AND ("data" -> 'cost' ->> 'input')::numeric BETWEEN 0 AND 1000000
        AND ("data" -> 'cost' ->> 'output')::numeric BETWEEN 0 AND 1000000
    ELSE FALSE END
);
