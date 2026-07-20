'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const migrationsRoot = path.resolve(__dirname, '..', 'prisma', 'migrations');
const identityMigration = '20260714040000_enforce_casefolded_attachment_identity';

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

test('session and attachment identities cannot acquire case-distinct aliases', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  const names = migrationNames();
  const identityIndex = names.indexOf(identityMigration);
  assert.notEqual(identityIndex, -1);

  for (const name of names.slice(0, identityIndex)) await applyMigration(pg, name);
  await pg.exec(`
    INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES
      ('account-a', 'public-a', now()),
      ('account-b', 'public-b', now());
    INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
    VALUES ('LegacySession', 'legacy-tag', 'account-a', 'encrypted', now());
  `);

  await applyMigration(pg, identityMigration);

  const legacy = await pg.query('SELECT "id" FROM "Session" WHERE "id" = \'LegacySession\'');
  assert.deepEqual(legacy.rows, [{ id: 'LegacySession' }]);

  await assert.rejects(pg.exec(`
    INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
    VALUES ('legacysession', 'case-alias', 'account-b', 'encrypted', now());
  `));
  await assert.rejects(pg.exec(`
    INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
    VALUES ('UPPERCASE-NEW', 'uppercase-new', 'account-b', 'encrypted', now());
  `));

  await pg.exec(`
    INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt")
    VALUES ('session-b', 'canonical', 'account-b', 'encrypted', now());
    INSERT INTO "Attachment"
      ("id", "accountId", "sessionId", "ref", "size", "status", "expiresAt", "updatedAt")
    VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'account-b', 'session-b',
       'sessions/session-b/attachments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.enc',
       1, 'UPLOADED', now(), now());
  `);

  await assert.rejects(pg.exec(`
    INSERT INTO "Attachment"
      ("id", "accountId", "sessionId", "ref", "size", "status", "expiresAt", "updatedAt")
    VALUES
      ('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'account-b', 'session-b',
       'sessions/session-b/attachments/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.enc',
       1, 'UPLOADED', now(), now());
  `));
});
