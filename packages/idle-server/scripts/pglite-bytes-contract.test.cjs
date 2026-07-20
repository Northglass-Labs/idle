'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { PrismaClient } = require('@prisma/client');
const { PrismaPGlite } = require('pglite-prisma-adapter');

test('PGlite round-trips Prisma Bytes fields on create and read', async t => {
  const pg = new PGlite();
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });

  t.after(async () => {
    await prisma.$disconnect();
    await pg.close();
  });

  await pg.exec(`
    CREATE TABLE "Session" (
      "id" TEXT PRIMARY KEY,
      "tag" TEXT NOT NULL,
      "accountId" TEXT NOT NULL,
      "metadata" TEXT NOT NULL,
      "metadataVersion" INTEGER NOT NULL DEFAULT 0,
      "agentState" TEXT,
      "agentStateVersion" INTEGER NOT NULL DEFAULT 0,
      "dataEncryptionKey" BYTEA,
      "seq" INTEGER NOT NULL DEFAULT 0,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const dataEncryptionKey = Uint8Array.from([
    0, 1, 2, 3, 127, 128, 253, 254, 255,
  ]);
  const created = await prisma.$transaction(tx => tx.session.create({
    data: {
      id: '00000000-0000-4000-8000-000000000001',
      tag: 'pglite-bytes-contract',
      accountId: 'pglite-bytes-account',
      metadata: 'encrypted-metadata',
      dataEncryptionKey,
    },
  }), { isolationLevel: 'Serializable' });

  assert.deepEqual(Buffer.from(created.dataEncryptionKey), Buffer.from(dataEncryptionKey));

  const read = await prisma.session.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.deepEqual(Buffer.from(read.dataEncryptionKey), Buffer.from(dataEncryptionKey));
});
