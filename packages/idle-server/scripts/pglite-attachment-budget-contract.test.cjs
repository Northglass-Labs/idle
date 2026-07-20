'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const migrationsRoot = path.resolve(__dirname, '..', 'prisma', 'migrations');
const budgetMigration = '20260714020000_add_attachment_storage_budget';
const transportMigration = '20260714030000_bind_attachment_transport';

function migrationNames() {
  return fs.readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => fs.existsSync(path.join(migrationsRoot, name, 'migration.sql')))
    .sort();
}

async function applyMigration(pg, name) {
  await pg.exec(fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8'));
}

test('attachment budget migration conservatively backfills every tracked object', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  const names = migrationNames();
  const budgetIndex = names.indexOf(budgetMigration);
  assert.notEqual(budgetIndex, -1);

  for (const name of names.slice(0, budgetIndex)) await applyMigration(pg, name);
  await pg.exec(`
    INSERT INTO "Account" ("id", "publicKey", "updatedAt")
    VALUES ('account-a', 'public-a', now());
    INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
    VALUES ('session-a', 'tag-a', 'account-a', 'encrypted', now());
    INSERT INTO "Attachment"
      ("id", "accountId", "sessionId", "ref", "size", "status", "expiresAt", "updatedAt")
    VALUES
      ('00000000-0000-4000-8000-000000000001', 'account-a', 'session-a',
       'sessions/session-a/attachments/00000000-0000-4000-8000-000000000001.enc',
       10, 'UPLOADED', now(), now()),
      ('00000000-0000-4000-8000-000000000002', 'account-a', 'session-a',
       'sessions/session-a/attachments/00000000-0000-4000-8000-000000000002.enc',
       20, 'PENDING', now() - interval '1 hour', now());
    INSERT INTO "AttachmentDeletion" ("id", "ref")
    VALUES ('legacy-delete', 'sessions/old/attachments/00000000-0000-4000-8000-000000000003.enc');
  `);
  for (const name of names.slice(budgetIndex)) await applyMigration(pg, name);

  const budget = await pg.query(`
    SELECT "accountedBytes", "objectCount"
    FROM "AttachmentStorageBudget"
    WHERE "id" = 'attachments'
  `);
  assert.deepEqual(budget.rows, [{ accountedBytes: 30, objectCount: 2 }]);

  const legacyDeletion = await pg.query(`
    SELECT "size" FROM "AttachmentDeletion" WHERE "id" = 'legacy-delete'
  `);
  assert.deepEqual(legacyDeletion.rows, [{ size: null }]);

  await assert.rejects(pg.exec(`
    UPDATE "AttachmentStorageBudget"
    SET "accountedBytes" = -1
    WHERE "id" = 'attachments';
  `), /AttachmentStorageBudget_accountedBytes_check/);
  await assert.rejects(pg.exec(`
    INSERT INTO "AttachmentDeletion" ("id", "ref", "size")
    VALUES ('invalid-delete', 'invalid.enc', 0);
  `), /AttachmentDeletion_size_check/);
});

test('attachment transport migration retains direct capabilities by default', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  const names = migrationNames();
  const transportIndex = names.indexOf(transportMigration);
  assert.notEqual(transportIndex, -1);

  for (const name of names.slice(0, transportIndex)) await applyMigration(pg, name);
  await pg.exec(`
    INSERT INTO "Account" ("id", "publicKey", "updatedAt")
    VALUES ('account-a', 'public-a', now());
    INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
    VALUES ('session-a', 'tag-a', 'account-a', 'encrypted', now());
    INSERT INTO "Attachment"
      ("id", "accountId", "sessionId", "ref", "size", "status", "expiresAt", "updatedAt")
    VALUES
      ('00000000-0000-4000-8000-000000000001', 'account-a', 'session-a',
       'sessions/session-a/attachments/00000000-0000-4000-8000-000000000001.enc',
       10, 'PENDING', now() - interval '1 hour', now());
  `);

  await applyMigration(pg, transportMigration);
  await pg.exec(`
    INSERT INTO "Attachment"
      ("id", "accountId", "sessionId", "ref", "size", "status", "expiresAt", "updatedAt")
    VALUES
      ('00000000-0000-4000-8000-000000000002', 'account-a', 'session-a',
       'sessions/session-a/attachments/00000000-0000-4000-8000-000000000002.enc',
       20, 'PENDING', now() + interval '1 hour', now());
  `);

  const transports = await pg.query(`
    SELECT "id", "transport"::text AS "transport"
    FROM "Attachment"
    ORDER BY "id"
  `);
  assert.deepEqual(transports.rows, [
    { id: '00000000-0000-4000-8000-000000000001', transport: 'DIRECT' },
    { id: '00000000-0000-4000-8000-000000000002', transport: 'DIRECT' },
  ]);
});
