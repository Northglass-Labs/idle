'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const migrationsRoot = path.resolve(__dirname, '..', 'prisma', 'migrations');
const admissionMigration = '20260714010000_add_deployment_account_admission';

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

test('account admission migration backfills a bounded deployment counter', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  const names = migrationNames();
  const admissionIndex = names.indexOf(admissionMigration);
  assert.notEqual(admissionIndex, -1);

  for (const name of names.slice(0, admissionIndex)) await applyMigration(pg, name);
  await pg.exec(`
    INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES
      ('account-a', 'public-a', now()),
      ('account-b', 'public-b', now());
  `);
  for (const name of names.slice(admissionIndex)) await applyMigration(pg, name);

  const budget = await pg.query(`
    SELECT "id", "admittedAccounts"
    FROM "DeploymentAccountBudget"
  `);
  assert.deepEqual(budget.rows, [{ id: 'accounts', admittedAccounts: 2 }]);

  await assert.rejects(pg.exec(`
    UPDATE "DeploymentAccountBudget"
    SET "admittedAccounts" = -1
    WHERE "id" = 'accounts';
  `), /DeploymentAccountBudget_admittedAccounts_check/);
});
