'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { PrismaClient } = require('@prisma/client');
const { PrismaPGlite } = require('pglite-prisma-adapter');

const migrationsRoot = path.resolve(__dirname, '..', 'prisma', 'migrations');
const usageMigrationName = '20260713050000_bound_usage_reports';

const canonicalData = {
  tokens: {
    total: 15,
    input: 5,
    output: 4,
    cache_creation: 3,
    cache_read: 3,
  },
  cost: { total: 0.15, input: 0.05, output: 0.10 },
};

async function applyMigration(pg, migrationName) {
  const sql = fs.readFileSync(
    path.join(migrationsRoot, migrationName, 'migration.sql'),
    'utf8',
  );
  await pg.exec(sql);
}

async function insertReport(pg, {
  id,
  accountId = 'account-a',
  sessionId,
  key = 'claude-session',
  data = canonicalData,
}) {
  await pg.query(`
    INSERT INTO "UsageReport"
      ("id", "key", "accountId", "sessionId", "data", "updatedAt")
    VALUES ($1, $2, $3, $4, $5::jsonb, now())
  `, [id, key, accountId, sessionId, JSON.stringify(data)]);
}

test('usage migration cleans legacy rows and enforces one bounded owned snapshot per session', async t => {
  const pg = new PGlite();
  let prisma;
  t.after(async () => {
    if (prisma) await prisma.$disconnect();
    await pg.close();
  });

  const migrationNames = fs.readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(migrationName => fs.existsSync(
      path.join(migrationsRoot, migrationName, 'migration.sql'),
    ))
    .sort();
  for (const migrationName of migrationNames) {
    if (migrationName === usageMigrationName) break;
    await applyMigration(pg, migrationName);
  }

  await pg.exec(`
    INSERT INTO "Account" ("id", "publicKey", "updatedAt") VALUES
      ('account-a', 'public-a', now()),
      ('account-b', 'public-b', now());
    INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "updatedAt") VALUES
      ('session-a', 'tag-a', 'account-a', 'encrypted-a', now()),
      ('session-b', 'tag-b', 'account-a', 'encrypted-b', now()),
      ('session-c', 'tag-c', 'account-a', 'encrypted-c', now()),
      ('session-d', 'tag-d', 'account-a', 'encrypted-d', now()),
      ('session-e', 'tag-e', 'account-a', 'encrypted-e', now()),
      ('session-f', 'tag-f', 'account-a', 'encrypted-f', now()),
      ('session-g', 'tag-g', 'account-a', 'encrypted-g', now());
  `);

  await insertReport(pg, { id: 'valid', sessionId: 'session-a' });
  await insertReport(pg, { id: 'arbitrary-key', sessionId: 'session-b', key: 'attacker-key' });
  await insertReport(pg, { id: 'sessionless', sessionId: null });
  await insertReport(pg, { id: 'cross-account', accountId: 'account-b', sessionId: 'session-c' });
  await insertReport(pg, {
    id: 'malformed',
    sessionId: 'session-d',
    data: { ...canonicalData, attacker: true },
  });
  await insertReport(pg, {
    id: 'inconsistent-total',
    sessionId: 'session-e',
    data: { ...canonicalData, tokens: { ...canonicalData.tokens, total: 16 } },
  });
  await insertReport(pg, {
    id: 'oversized',
    sessionId: 'session-f',
    data: { ...canonicalData, padding: 'x'.repeat(2_000) },
  });

  await applyMigration(pg, usageMigrationName);

  const retained = await pg.query('SELECT "id" FROM "UsageReport" ORDER BY "id"');
  assert.deepEqual(retained.rows, [{ id: 'valid' }]);

  await assert.rejects(
    insertReport(pg, { id: 'new-sessionless', sessionId: null }),
    /sessionId.*not-null|not-null.*sessionId/i,
  );
  await assert.rejects(
    insertReport(pg, { id: 'new-arbitrary-key', sessionId: 'session-b', key: 'attacker-key' }),
    /UsageReport_key_check/,
  );
  await assert.rejects(
    insertReport(pg, {
      id: 'new-oversized',
      sessionId: 'session-b',
      data: { ...canonicalData, padding: 'x'.repeat(2_000) },
    }),
    /UsageReport_data_bytes_check/,
  );
  await assert.rejects(
    insertReport(pg, {
      id: 'new-inconsistent-total',
      sessionId: 'session-b',
      data: { ...canonicalData, tokens: { ...canonicalData.tokens, total: 16 } },
    }),
    /UsageReport_data_check/,
  );
  await assert.rejects(
    insertReport(pg, {
      id: 'new-cross-account',
      accountId: 'account-b',
      sessionId: 'session-g',
    }),
    /UsageReport_sessionId_accountId_fkey/,
  );
  await assert.rejects(
    insertReport(pg, { id: 'new-duplicate-session', sessionId: 'session-a' }),
    /UsageReport_sessionId_key/,
  );

  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  await prisma.usageReport.upsert({
    where: { sessionId: 'session-a', accountId: 'account-a' },
    update: { data: canonicalData },
    create: {
      key: 'claude-session',
      accountId: 'account-a',
      sessionId: 'session-a',
      data: canonicalData,
    },
  });

  await pg.exec(`UPDATE "Session" SET "accountId" = 'account-b' WHERE "id" = 'session-a'`);
  const reassigned = await pg.query(`
    SELECT "accountId", "sessionId" FROM "UsageReport" WHERE "id" = 'valid'
  `);
  assert.deepEqual(reassigned.rows, [{ accountId: 'account-b', sessionId: 'session-a' }]);

  const staleWriteData = {
    tokens: { ...canonicalData.tokens, total: 16, input: 6 },
    cost: canonicalData.cost,
  };
  await assert.rejects(prisma.usageReport.upsert({
    where: { sessionId: 'session-a', accountId: 'account-a' },
    update: { data: staleWriteData },
    create: {
      key: 'claude-session',
      accountId: 'account-a',
      sessionId: 'session-a',
      data: staleWriteData,
    },
  }));
  const afterStaleWrite = await pg.query(`
    SELECT "accountId", "data" FROM "UsageReport" WHERE "id" = 'valid'
  `);
  assert.equal(afterStaleWrite.rows[0].accountId, 'account-b');
  assert.deepEqual(afterStaleWrite.rows[0].data, canonicalData);

  await pg.exec(`DELETE FROM "Session" WHERE "id" = 'session-a'`);
  const afterSessionDelete = await pg.query(`SELECT count(*)::int AS count FROM "UsageReport"`);
  assert.equal(afterSessionDelete.rows[0].count, 0);
});
