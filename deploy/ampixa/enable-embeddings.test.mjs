import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFINITION,
  MODEL,
  PROFILE,
  databasePreflight,
  embeddingConfig,
  existingProfile,
  probeGemini,
  provision,
  readConfig,
  saveConfig,
  verifyPreflight,
} from './enable-embeddings.mjs';

const config = () => ({
  server: { name: 'Test' },
  indexer: { enabled: true },
  copilot: {
    enabled: true,
    byok: {
      enabled: true,
      allowedProviders: ['openai'],
      allowCustomEndpoint: true,
      allowPrivateEndpoint: true,
    },
  },
});
const profile = () => ({
  profileId: 'embedding-profile',
  name: PROFILE,
  provider: 'gemini',
  enabled: true,
  definition: structuredClone(DEFINITION),
});
const haiku = () => ({
  profileId: 'chat-profile',
  name: 'Claude Haiku',
  provider: 'openai',
  enabled: true,
  definition: {
    endpoint: { kind: 'openai_compatible', url: 'http://127.0.0.1:3011/v1' },
    models: [
      {
        modelId: 'claude-haiku-5-5',
        enabled: true,
        capabilities: [{ input: ['text'], output: ['text'] }],
      },
    ],
  },
});
const state = () => ({
  pgvector: '0.8.7',
  workspaceReady: true,
  ownerReady: true,
  profiles: [haiku()],
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'affine-embedding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config()), { mode: 0o640 });
  await chmod(path, 0o640);
  return { dir, path };
}

test('extends only the allowlist; preserves Haiku, private endpoint and unrelated settings', () => {
  const original = config();
  const expected = config();
  expected.copilot.byok.allowedProviders.push('gemini');
  assert.deepEqual(embeddingConfig(original), expected);
  assert.deepEqual(original, config());
  assert.deepEqual(embeddingConfig(expected), expected);
  delete expected.copilot.byok.allowedProviders;
  assert.deepEqual(embeddingConfig(expected), expected);
});

test('refuses disabled Intelligence/BYOK and malformed config', () => {
  for (const value of [
    null,
    [],
    {},
    { copilot: {} },
    { copilot: { enabled: false, byok: { enabled: true } } },
  ]) {
    assert.throws(() => embeddingConfig(value), /Enable Intelligence/);
  }
  const bad = config();
  bad.copilot.byok.allowedProviders = 'openai';
  assert.throws(() => embeddingConfig(bad), /allowlist/);
});

test('config read is dry; apply is atomic, preserves permissions, backs up privately, and is idempotent', async t => {
  const { dir, path } = await fixture(t);
  const before = await stat(path);
  const snapshot = await readConfig(path);
  assert.deepEqual(await readdir(dir), ['config.json']);
  const backup = await saveConfig(snapshot);
  assert.deepEqual(JSON.parse(await readFile(backup)), config());
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  const after = await stat(path);
  assert.deepEqual(
    [after.uid, after.gid, after.mode],
    [before.uid, before.gid, before.mode]
  );
  assert.deepEqual(JSON.parse(await readFile(path)), embeddingConfig(config()));
  assert.equal(await saveConfig(await readConfig(path)), undefined);
  assert.equal((await readdir(dir)).length, 2);
});

test('symlinks and concurrent config edits are refused without overwriting', async t => {
  const { dir, path } = await fixture(t);
  const link = join(dir, 'link.json');
  await symlink(path, link);
  await assert.rejects(readConfig(link), /regular file/);
  const snapshot = await readConfig(path);
  await writeFile(path, '{}');
  await assert.rejects(saveConfig(snapshot), /changed during preflight/);
  assert.equal(await readFile(path, 'utf8'), '{}');
  assert.equal((await readdir(dir)).length, 2);
});

const goodResponse = () => ({
  ok: true,
  json: async () => ({
    embeddings: [0, 1].map(() => ({ values: Array(1024).fill(0.1) })),
  }),
});
test('synthetic probe checks document + query at 1024 dimensions without putting the key in URL/body', async () => {
  await probeGemini('synthetic-key', async (url, options) => {
    assert.equal(
      url,
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`
    );
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-goog-api-key'], 'synthetic-key');
    assert.equal(options.body.includes('synthetic-key'), false);
    const requests = JSON.parse(options.body).requests;
    assert.deepEqual(
      requests.map(r => r.taskType),
      ['RETRIEVAL_DOCUMENT', 'RETRIEVAL_QUERY']
    );
    assert.ok(
      requests.every(
        r => r.outputDimensionality === 1024 && r.model === `models/${MODEL}`
      )
    );
    return goodResponse();
  });
});

for (const [label, values] of [
  ['wrong dimensions', [0.1]],
  ['zero vector', Array(1024).fill(0)],
  ['NaN', Array(1024).fill(NaN)],
]) {
  test(`rejects ${label}`, async () => {
    await assert.rejects(
      probeGemini('key', async () => ({
        ok: true,
        json: async () => ({ embeddings: [{ values }, { values }] }),
      })),
      /1024-dimensional/
    );
  });
}
test('probe error never echoes provider error bodies or request credentials', async () => {
  await assert.rejects(
    probeGemini('secret', async () => {
      throw new Error('secret');
    }),
    /failed to connect/
  );
  await assert.rejects(
    probeGemini('secret', async () => ({
      ok: false,
      status: 403,
      json: () => {
        throw new Error('secret');
      },
    })),
    /HTTP 403/
  );
  await assert.rejects(probeGemini('two keys'), /one Gemini API key/);
});

test('preflight requires actual pgvector >=0.8, enabled workspace and active owner', () => {
  verifyPreflight(state());
  verifyPreflight({ ...state(), pgvector: '1.0.0' });
  for (const pgvector of [null, '0.6.0', '0.7.4', 'unknown'])
    assert.throws(() => verifyPreflight({ ...state(), pgvector }), /pgvector/);
  for (const key of ['workspaceReady', 'ownerReady'])
    assert.throws(
      () => verifyPreflight({ ...state(), [key]: false }),
      /active owner/
    );
  assert.throws(
    () => databasePreflight('workspace', 'owner', {}),
    /DATABASE_URL/
  );
});

test('preserves chat profiles, reuses exact embedding profile, rejects competing and legacy profiles', () => {
  assert.equal(existingProfile([haiku()]), undefined);
  assert.equal(
    existingProfile([haiku(), profile()]).profileId,
    'embedding-profile'
  );
  assert.throws(
    () =>
      existingProfile([haiku(), { ...profile(), name: 'Other embeddings' }]),
    /manual migration/
  );
  assert.throws(
    () => existingProfile([{ ...profile(), enabled: false }]),
    /differs/
  );
  assert.throws(
    () => existingProfile([{ ...haiku(), definition: {} }]),
    /Legacy/
  );
  const wrong = profile();
  wrong.definition.models[0].modelId = 'other';
  assert.throws(() => existingProfile([wrong]), /differs/);
});

function fakeRuntime(profiles = [haiku()]) {
  const calls = [];
  return {
    calls,
    profiles,
    start: async () => {
      calls.push('start');
    },
    stop: async () => {
      calls.push('stop');
    },
    embeddingHealth: async () => ({ enabled: true }),
    getByokPolicy: () => ({
      enabled: true,
      allowedProviders: ['openai', 'gemini'],
    }),
    listByokProfiles: async () => profiles,
    createByokProfile: async input => {
      calls.push(['create', input]);
      profiles.push(profile());
      return profiles.at(-1);
    },
    probeByokProfile: async input => {
      calls.push(['probe', input]);
      return {
        stale: false,
        connection: { kind: 'verified' },
        models: [
          {
            modelId: MODEL,
            checks: [{ operation: 'embedding', status: { kind: 'verified' } }],
          },
        ],
      };
    },
    assertCopilotRoute: async input => {
      calls.push(['route', input]);
    },
  };
}
const options = {
  workspaceId: 'workspace',
  actorUserId: 'owner',
  credential: 'synthetic-key',
  managedTier: 'standard',
};

test('provisions embedding-only server profile and checks background route; never changes Haiku', async () => {
  const runtime = fakeRuntime();
  await provision(runtime, options, () => {});
  assert.deepEqual(runtime.profiles[0], haiku());
  const create = runtime.calls.find(c => c[0] === 'create')[1];
  assert.deepEqual(create.definition, DEFINITION);
  assert.equal(create.credential, 'synthetic-key');
  const route = runtime.calls.find(c => c[0] === 'route')[1];
  assert.equal(route.slot, 'index.embedding');
  assert.equal(route.access.localByok, false);
  assert.equal(route.access.serverByok, true);
  assert.equal(runtime.calls.at(-1), 'stop');
});

test('rerun probes stored key without rotating credentials or creating duplicates', async () => {
  const runtime = fakeRuntime([haiku(), profile()]);
  await provision(runtime, options, () => {});
  assert.equal(
    runtime.calls.some(c => c[0] === 'create'),
    false
  );
  assert.equal(runtime.calls.filter(c => c[0] === 'probe').length, 1);
});

test('a post-commit reconciliation failure is not blindly retried; saved profile survives', async () => {
  const runtime = fakeRuntime();
  runtime.createByokProfile = async () => {
    runtime.profiles.push(profile());
    throw new Error('embedding_unavailable');
  };
  await assert.rejects(
    provision(runtime, options, () => {}),
    /embedding_unavailable/
  );
  assert.equal(runtime.profiles.length, 2);
  assert.equal(runtime.calls.at(-1), 'stop');
  await provision(runtime, options, () => {});
  assert.equal(runtime.profiles.length, 2);
});

test('native failures always stop the runtime and do not claim success', async () => {
  for (const method of [
    'start',
    'createByokProfile',
    'probeByokProfile',
    'assertCopilotRoute',
  ]) {
    const runtime = fakeRuntime();
    runtime[method] = async () => {
      throw new Error('injected failure');
    };
    await assert.rejects(provision(runtime, options, () => {}));
    assert.equal(runtime.calls.at(-1), 'stop');
  }
  for (const result of [
    {},
    { stale: true, connection: { kind: 'verified' } },
    { stale: false, connection: { kind: 'verified' }, models: [] },
  ]) {
    const runtime = fakeRuntime();
    runtime.probeByokProfile = async () => result;
    await assert.rejects(
      provision(runtime, options, () => {}),
      /native probe/
    );
    assert.equal(
      runtime.calls.some(c => c[0] === 'route'),
      false
    );
    assert.equal(runtime.calls.at(-1), 'stop');
  }
});

test('effective database policy overrides block mutation', async () => {
  const runtime = fakeRuntime();
  runtime.getByokPolicy = () => ({
    enabled: true,
    allowedProviders: ['openai'],
  });
  await assert.rejects(
    provision(runtime, options, () => {}),
    /Effective BYOK policy/
  );
  assert.equal(
    runtime.calls.some(c => c[0] === 'create'),
    false
  );
});

test('CLI dry run consumes stdin, probes synthetically, and never loads native runtime or writes', async t => {
  const { dir, path } = await fixture(t);
  const psql = join(dir, 'psql');
  await writeFile(
    psql,
    "#!/bin/sh\ncat >/dev/null\nprintf '%s' '" +
      JSON.stringify(state()) +
      "'\n",
    { mode: 0o700 }
  );
  const preload = join(dir, 'fetch.mjs');
  await writeFile(
    preload,
    `globalThis.fetch = async () => ({ ok: true, json: async () => ({ embeddings: [0,1].map(() => ({values:Array(1024).fill(0.1)})) }) });`
  );
  const before = await readdir(dir);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      new URL('./enable-embeddings.mjs', import.meta.url).pathname,
      '--workspace',
      'workspace',
      '--owner',
      'owner',
      '--config',
      path,
      '--native',
      '/missing/native.node',
    ],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DATABASE_URL: 'postgresql://synthetic',
        DEPLOYMENT_TYPE: 'selfhosted',
      },
      input: 'synthetic-key\n',
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run passed/);
  assert.equal(
    (result.stdout + result.stderr).includes('synthetic-key'),
    false
  );
  assert.deepEqual(JSON.parse(await readFile(path)), config());
  assert.deepEqual(await readdir(dir), before);
});

test('CLI apply refuses a running service before any config writes or provider calls', async t => {
  const { dir, path } = await fixture(t);
  await writeFile(join(dir, 'systemctl'), '#!/bin/sh\nprintf active\n', {
    mode: 0o700,
  });
  const result = spawnSync(
    process.execPath,
    [
      new URL('./enable-embeddings.mjs', import.meta.url).pathname,
      '--workspace',
      'workspace',
      '--owner',
      'owner',
      '--config',
      path,
      '--apply',
    ],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DEPLOYMENT_TYPE: 'selfhosted',
      },
      input: 'synthetic-key',
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stop affine.service/);
  assert.deepEqual(JSON.parse(await readFile(path)), config());
  assert.equal((await readdir(dir)).length, 2);
});

test('CLI apply persists policy, loads the updated config, and shuts down the native runtime', async t => {
  const { dir, path } = await fixture(t);
  await writeFile(join(dir, 'systemctl'), '#!/bin/sh\nprintf inactive\n', {
    mode: 0o700,
  });
  await writeFile(
    join(dir, 'psql'),
    "#!/bin/sh\ncat >/dev/null\nprintf '%s' '" +
      JSON.stringify(state()) +
      "'\n",
    { mode: 0o700 }
  );
  const preload = join(dir, 'fetch.mjs');
  await writeFile(
    preload,
    `globalThis.fetch = async () => ({ ok:true, json:async () => ({embeddings:[0,1].map(() => ({values:Array(1024).fill(0.1)}))}) });`
  );
  const native = join(dir, 'native.cjs');
  await writeFile(
    native,
    `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    module.exports = {
      validateAppConfigValue: () => [], CopilotManagedTier: {Standard:'standard'},
      BackendRuntime: class {
        constructor(key, paths) { assert.equal(key, 'synthetic-private-key'); assert.ok(JSON.parse(fs.readFileSync(paths[0])).copilot.byok.allowedProviders.includes('gemini')); }
        async start() {}
        async stop() { console.log('FAKE_STOPPED'); }
        async embeddingHealth() { return {enabled:true}; }
        getByokPolicy() { return {enabled:true,allowedProviders:['gemini']}; }
        async listByokProfiles() { return []; }
        async createByokProfile(input) { assert.equal(input.credential,'synthetic-key'); return {profileId:'test-profile'}; }
        async probeByokProfile() { return {stale:false,connection:{kind:'verified'},models:[{modelId:'gemini-embedding-001',checks:[{operation:'embedding',status:{kind:'verified'}}]}]}; }
        async assertCopilotRoute(input) { assert.equal(input.slot,'index.embedding'); assert.equal(input.access.localByok,false); }
      }
    };
  `
  );
  const privateKey = join(dir, 'private.key');
  await writeFile(privateKey, 'synthetic-private-key');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      new URL('./enable-embeddings.mjs', import.meta.url).pathname,
      '--workspace',
      'workspace',
      '--owner',
      'owner',
      '--config',
      path,
      '--native',
      native,
      '--private-key',
      privateKey,
      '--apply',
    ],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        DATABASE_URL: 'postgresql://synthetic',
        DEPLOYMENT_TYPE: 'selfhosted',
      },
      input: 'synthetic-key',
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Server embedding route verified/);
  assert.match(result.stdout, /FAKE_STOPPED/);
  assert.equal(
    (result.stdout + result.stderr).includes('synthetic-key'),
    false
  );
  assert.deepEqual(JSON.parse(await readFile(path)), embeddingConfig(config()));
});
