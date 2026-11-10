import test from 'ava';
import * as Y from 'yjs';

import type { EventBus, Mutex } from '../../base';
import type { PgWorkspaceDocStorageAdapter } from '../../core/doc/adapters/workspace';
import {
  FolderService,
  indexAfter,
  readFolderRows,
} from '../../core/doc/folders';

// Rows written the way the frontend ORM does: one top-level Y.Map per row id.
function foldersDoc() {
  const doc = new Y.Doc();
  const row = (id: string, fields: Record<string, unknown>) => {
    const map = doc.getMap(id);
    map.set('id', id);
    for (const [key, value] of Object.entries(fields)) map.set(key, value);
  };
  const a = indexAfter(null);
  const b = indexAfter(a);
  row('funding', { parentId: null, type: 'folder', data: 'Funding', index: a });
  row('link-1', { parentId: 'funding', type: 'doc', data: 'doc-1', index: a });
  row('link-2', { parentId: 'funding', type: 'doc', data: 'doc-2', index: b });
  row('gone', {
    parentId: 'funding',
    type: 'doc',
    data: 'doc-x',
    index: b,
    $$DELETED: true,
  });
  return doc;
}

function fixture() {
  const stored = foldersDoc();
  const writes: unknown[][] = [];
  const events: unknown[][] = [];
  const service = new FolderService(
    {
      getDoc: async () => ({ bin: Y.encodeStateAsUpdate(stored) }),
      pushDocUpdates: async (...args: unknown[]) => {
        writes.push(args);
        for (const update of args[2] as Uint8Array[])
          Y.applyUpdate(stored, update);
        return Date.now();
      },
    } as unknown as PgWorkspaceDocStorageAdapter,
    { emit: (...args: unknown[]) => events.push(args) } as unknown as EventBus,
    {
      acquire: async () => ({ [Symbol.asyncDispose]: async () => {} }),
    } as unknown as Mutex
  );
  return { stored, writes, events, service };
}

const signal = new AbortController().signal;

test('list_folders reads folders and their live doc links', async t => {
  const f = fixture();
  t.deepEqual(await f.service.list('ws', signal), [
    {
      id: 'funding',
      name: 'Funding',
      parentId: null,
      docIds: ['doc-1', 'doc-2'],
    },
  ]);
});

test('add_document_to_folder appends last, is idempotent', async t => {
  const f = fixture();
  const first = await f.service.addDoc('ws', 'funding', 'doc-3', 'u', signal);
  t.true(first.added);
  t.is(f.writes.length, 1);
  t.is(f.writes[0][1], 'db$ws$folders');
  t.is((f.events[0][1] as { docId: string }).docId, 'db$ws$folders');

  const rows = readFolderRows(f.stored).filter(r => r.parentId === 'funding');
  const sorted = rows.sort((a, b) => (a.index > b.index ? 1 : -1));
  t.deepEqual(
    sorted.map(r => r.data),
    ['doc-1', 'doc-2', 'doc-3']
  );
  t.like(sorted[2], { id: first.linkId, type: 'doc', parentId: 'funding' });

  const again = await f.service.addDoc('ws', 'funding', 'doc-3', 'u', signal);
  t.deepEqual(again, { linkId: first.linkId, added: false });
  t.is(f.writes.length, 1);
});

test('add_document_to_folder rejects unknown or non-folder targets', async t => {
  const f = fixture();
  for (const target of ['nope', 'link-1', 'gone']) {
    await t.throwsAsync(f.service.addDoc('ws', target, 'doc-3', 'u', signal), {
      message: /^FOLDER_NOT_FOUND/,
    });
  }
  t.is(f.writes.length, 0);
});

test('indexAfter keeps the frontend key format and ordering', t => {
  let last: string | null = null;
  for (let i = 0; i < 50; i++) {
    const next = indexAfter(last);
    t.regex(next, /0[1-9A-Za-z]{32}$/);
    if (last) t.true(next > last);
    last = next;
  }
});
