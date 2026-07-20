'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const migrationsRoot = path.resolve(__dirname, '..', 'prisma', 'migrations');

async function applyAllMigrations(pg) {
  const names = fs.readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => fs.existsSync(path.join(migrationsRoot, name, 'migration.sql')))
    .sort();
  for (const name of names) {
    await pg.exec(fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8'));
  }
}

test('voice capacity migration provides bounded, token-free durable leases', async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await applyAllMigrations(pg);

  const columns = await pg.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'VoiceCapacityReservation'
    ORDER BY ordinal_position
  `);
  assert.deepEqual(columns.rows.map(row => row.column_name), [
    'id',
    'accountId',
    'requestId',
    'reservedSeconds',
    'providerConversationId',
    'expiresAt',
    'createdAt',
    'updatedAt',
  ]);
  assert.equal(columns.rows.some(row => /token|jwt|secret/i.test(row.column_name)), false);

  await pg.exec(`
    INSERT INTO "Account" ("id", "publicKey", "updatedAt")
    VALUES ('voice-account', 'voice-public-key', now());
    INSERT INTO "VoiceCapacityReservation"
      ("id", "accountId", "requestId", "reservedSeconds", "expiresAt", "updatedAt")
    VALUES
      ('lease-a', 'voice-account', 'request-a', 60, now() + interval '1 hour', now());
  `);

  await assert.rejects(pg.exec(`
    INSERT INTO "VoiceCapacityReservation"
      ("id", "accountId", "requestId", "reservedSeconds", "expiresAt", "updatedAt")
    VALUES
      ('lease-duplicate', 'voice-account', 'request-a', 60, now() + interval '1 hour', now());
  `), /VoiceCapacityReservation_accountId_requestId_key/);

  await assert.rejects(pg.exec(`
    INSERT INTO "VoiceCapacityReservation"
      ("id", "accountId", "requestId", "reservedSeconds", "expiresAt", "updatedAt")
    VALUES
      ('lease-unbounded', 'voice-account', 'request-b', 0, now() + interval '1 hour', now());
  `), /VoiceCapacityReservation_reservedSeconds_check/);

  await pg.exec(`DELETE FROM "Account" WHERE "id" = 'voice-account'`);
  const afterDelete = await pg.query(`
    SELECT count(*)::int AS count FROM "VoiceCapacityReservation"
  `);
  assert.equal(afterDelete.rows[0].count, 0);
});
