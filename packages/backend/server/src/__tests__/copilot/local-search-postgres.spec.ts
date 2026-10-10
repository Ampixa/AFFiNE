import { PrismaClient } from '@prisma/client';
import test from 'ava';

import type { EventBus } from '../../base';
import { DocModel } from '../../models/doc';

// Uses transaction-local temporary tables, never application tables. Run with
// LOCAL_SEARCH_TEST_DATABASE_URL pointed at a disposable local PostgreSQL DB.
const databaseUrl = process.env.LOCAL_SEARCH_TEST_DATABASE_URL;
const pgTest = databaseUrl ? test.serial : test.skip;

pgTest(
  'PostgreSQL enforces byte/part limits and workspace isolation before transferring document bytes',
  async t => {
    const client = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      await client.$transaction(async tx => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE snapshots (workspace_id text, guid text, blob bytea, updated_at timestamptz) ON COMMIT DROP'
        );
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE updates (workspace_id text, guid text, blob bytea, created_at timestamptz) ON COMMIT DROP'
        );
        const model = new DocModel({} as EventBus);
        Object.defineProperty(model, 'db', { value: tx });
        const exact = Buffer.alloc(1024 * 1024, 65);
        await tx.$executeRaw`INSERT INTO snapshots VALUES ('a', 'exact', ${exact}, now()), ('other', 'exact', ${Buffer.from('private')}, now())`;
        const accepted = await model.getBoundedSearchUpdates('a', 'exact');
        t.truthy(accepted && !accepted.limited);
        if (accepted && !accepted.limited) {
          t.is(accepted.bytes, 1024 * 1024);
          t.is(accepted.updates.length, 1);
          t.is(accepted.updates[0].byteLength, 1024 * 1024);
        }
        await tx.$executeRaw`INSERT INTO updates VALUES ('a', 'exact', ${Buffer.from('x')}, now())`;
        t.deepEqual(await model.getBoundedSearchUpdates('a', 'exact'), {
          limited: true,
        });
        t.is(
          await model.getBoundedSearchUpdates("a' OR true --", 'exact'),
          null
        );
        await tx.$executeRaw`INSERT INTO updates SELECT 'a', 'many', ${Buffer.from('x')}, now() + n * interval '1 millisecond' FROM generate_series(1, 128) n`;
        const parts = await model.getBoundedSearchUpdates('a', 'many');
        t.truthy(parts && !parts.limited && parts.updates.length === 128);
        await tx.$executeRaw`INSERT INTO updates VALUES ('a', 'many', ${Buffer.from('x')}, now() + interval '1 second')`;
        t.deepEqual(await model.getBoundedSearchUpdates('a', 'many'), {
          limited: true,
        });
      });
    } finally {
      await client.$disconnect();
    }
  }
);
