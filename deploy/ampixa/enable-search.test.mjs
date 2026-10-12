import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { enableSearch, searchConfig } from './enable-search.mjs';

async function fixture(
  t,
  reply = [{ data: [{ 1: 1 }], error: '' }],
  status = 200
) {
  const directory = await mkdtemp(join(tmpdir(), 'affine-search-'));
  const path = join(directory, 'config.json');
  const original = {
    server: { name: 'Test workspace' },
    copilot: { secret: 'synthetic-secret' },
  };
  await writeFile(path, JSON.stringify(original), { mode: 0o640 });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/sql?mode=raw');
    assert.equal(new URLSearchParams(body).get('query'), 'SELECT 1');
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    original,
    endpoint: `http://127.0.0.1:${server.address().port}`,
  };
}

test('dry run checks SQL health without changing or backing up configuration', async t => {
  const f = await fixture(t);
  assert.deepEqual(await enableSearch(f.path, f.endpoint), {
    changed: true,
    applied: false,
  });
  assert.deepEqual(JSON.parse(await readFile(f.path)), f.original);
  assert.deepEqual(await readdir(f.directory), ['config.json']);
});

test('apply preserves settings and file ownership/mode and creates a private backup', async t => {
  const f = await fixture(t);
  await chmod(f.path, 0o640);
  const before = await stat(f.path);
  const result = await enableSearch(f.path, f.endpoint, true);
  const saved = JSON.parse(await readFile(f.path));
  assert.equal(result.applied, true);
  assert.deepEqual(saved.copilot, f.original.copilot);
  assert.deepEqual(saved.server, f.original.server);
  assert.deepEqual(saved.indexer, {
    enabled: true,
    provider: { type: 'manticoresearch', endpoint: f.endpoint },
  });
  assert.deepEqual(JSON.parse(await readFile(result.backup)), f.original);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  const after = await stat(f.path);
  assert.deepEqual(
    [after.uid, after.gid, after.mode],
    [before.uid, before.gid, before.mode]
  );
  assert.deepEqual(await enableSearch(f.path, f.endpoint, true), {
    changed: false,
    applied: false,
  });
  assert.equal((await readdir(f.directory)).length, 2);
});

for (const [label, reply, status] of [
  ['HTTP failure', {}, 503],
  ['SQL error inside HTTP 200', [{ error: 'SQL failed' }], 200],
  ['unrelated service', { ok: true }, 200],
]) {
  test(`${label} leaves the config unchanged`, async t => {
    const f = await fixture(t, reply, status);
    await assert.rejects(
      enableSearch(f.path, f.endpoint, true),
      /health check/
    );
    assert.deepEqual(JSON.parse(await readFile(f.path)), f.original);
    assert.deepEqual(await readdir(f.directory), ['config.json']);
  });
}

test('refuses symlinks, remote endpoints and silent migration of existing providers', async t => {
  const f = await fixture(t);
  const link = join(f.directory, 'link.json');
  await symlink(f.path, link);
  await assert.rejects(enableSearch(link, f.endpoint, true), /regular file/);
  await assert.rejects(
    enableSearch(f.path, 'http://search.example:9308', true),
    /loopback/
  );
  await assert.rejects(
    enableSearch(f.path, 'http://user:password@localhost:9308', true),
    /loopback/
  );
  for (const provider of [
    { type: 'elasticsearch' },
    { endpoint: 'http://other:9308' },
    { apiKey: 'synthetic' },
  ]) {
    assert.throws(
      () => searchConfig({ indexer: { provider } }, f.endpoint),
      /manually/
    );
  }
  assert.throws(() => searchConfig([], f.endpoint), /configuration object/);
  assert.deepEqual(JSON.parse(await readFile(f.path)), f.original);
});
