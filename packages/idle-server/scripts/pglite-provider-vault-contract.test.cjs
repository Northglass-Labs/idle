'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const migrationsRoot = path.resolve(__dirname, '..', 'prisma', 'migrations');
const dropMigrationName = '20260713060000_drop_service_account_tokens';

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

async function retiredTableIsPresent(pg) {
  const result = await pg.query(`
    SELECT to_regclass('"ServiceAccountToken"') IS NOT NULL AS present
  `);
  return result.rows[0].present;
}

test('full migration chain drops the retired relay provider-token vault', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());

  const names = migrationNames();
  const dropIndex = names.indexOf(dropMigrationName);
  assert.notEqual(dropIndex, -1, 'provider-vault removal migration must be packaged');

  for (const name of names.slice(0, dropIndex)) await applyMigration(pg, name);
  assert.equal(await retiredTableIsPresent(pg), true, 'legacy table must exist before its removal migration');

  await pg.exec(`
    INSERT INTO "Account" ("id", "publicKey", "updatedAt")
    VALUES ('migration-account', 'migration-public-key', now());
    INSERT INTO "ServiceAccountToken" ("id", "accountId", "vendor", "token", "updatedAt")
    VALUES ('retired-token', 'migration-account', 'retired-provider', decode('00', 'hex'), now());
  `);

  for (const name of names.slice(dropIndex)) await applyMigration(pg, name);
  assert.equal(await retiredTableIsPresent(pg), false);
});
