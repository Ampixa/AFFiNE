import { McpAccessMode } from '@prisma/client';
import test from 'ava';
import * as Y from 'yjs';

import type { EventBus, Mutex } from '../../base';
import type { PgWorkspaceDocStorageAdapter } from '../../core/doc/adapters/workspace';
import {
  FolderService,
  indexAfter,
  readFolderRows,
} from '../../core/doc/folders';
import { WorkspaceMcpProvider } from '../../plugins/copilot/mcp/provider';

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

function fixture(
  options: {
    missing?: boolean;
    busy?: boolean;
    read?: () => void;
    write?: () => Promise<void>;
  } = {}
) {
  const stored = foldersDoc();
  const writes: unknown[][] = [];
  const events: unknown[][] = [];
  let locked = false;
  const service = new FolderService(
    {
      getDoc: async (_ws: string, id: string) => {
        options.read?.();
        return options.missing && !id.startsWith('db$')
          ? null
          : { bin: Y.encodeStateAsUpdate(stored) };
      },
      pushDocUpdates: async (...args: unknown[]) => {
        if (!locked) throw new Error('Lock released before write finished');
        await options.write?.();
        if (!locked) throw new Error('Lock released during write');
        writes.push(args);
        for (const update of args[2] as Uint8Array[])
          Y.applyUpdate(stored, update);
        return Date.now();
      },
    } as unknown as PgWorkspaceDocStorageAdapter,
    { emit: (...args: unknown[]) => events.push(args) } as unknown as EventBus,
    {
      acquire: async () => {
        if (locked || options.busy) return undefined;
        locked = true;
        return {
          [Symbol.asyncDispose]: async () => {
            locked = false;
          },
        };
      },
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
  const first = await f.service.addDoc(
    'ws',
    'funding',
    'doc-3',
    'u',
    signal,
    async () => {}
  );
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

  const again = await f.service.addDoc(
    'ws',
    'funding',
    'doc-3',
    'u',
    signal,
    async () => {}
  );
  t.deepEqual(again, { linkId: first.linkId, added: false });
  t.is(f.writes.length, 1);
});

test('add_document_to_folder rejects unknown or non-folder targets', async t => {
  const f = fixture();
  for (const target of ['nope', 'link-1', 'gone']) {
    await t.throwsAsync(
      f.service.addDoc('ws', target, 'doc-3', 'u', signal, async () => {}),
      {
        message: /^FOLDER_NOT_FOUND/,
      }
    );
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

test('folder write retains the lock until storage completes', async t => {
  let release!: () => void;
  let writing!: () => void;
  const started = new Promise<void>(resolve => {
    writing = resolve;
  });
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const f = fixture({
    write: async () => {
      writing();
      await hold;
    },
  });
  const first = f.service.addDoc(
    'ws',
    'funding',
    'doc-3',
    'u',
    signal,
    async () => {}
  );
  await started;
  try {
    await t.throwsAsync(
      f.service.addDoc('ws', 'funding', 'doc-3', 'u', signal, async () => {}),
      { message: /^FOLDERS_BUSY/ }
    );
  } finally {
    release();
  }
  t.true((await first).added);
  t.false(
    (
      await f.service.addDoc(
        'ws',
        'funding',
        'doc-3',
        'u',
        signal,
        async () => {}
      )
    ).added
  );
  t.is(f.writes.length, 1);
});

test('folder writes fail closed for missing docs and revoked permissions', async t => {
  const missing = fixture({ missing: true });
  await t.throwsAsync(
    missing.service.addDoc(
      'ws',
      'funding',
      'missing',
      'u',
      signal,
      async () => {}
    ),
    { message: /^DOCUMENT_NOT_FOUND/ }
  );
  t.is(missing.writes.length, 0);
  const f = fixture();
  let checks = 0;
  await t.throwsAsync(
    f.service.addDoc('ws', 'funding', 'doc-3', 'u', signal, async () => {
      if (++checks === 2) throw new Error('revoked');
    }),
    { message: 'revoked' }
  );
  t.is(f.writes.length, 0);
  t.is(f.events.length, 0);
});

test('aborting a folder read prevents any write', async t => {
  const abort = new AbortController();
  const f = fixture({ read: () => abort.abort() });
  await t.throwsAsync(
    f.service.addDoc(
      'ws',
      'funding',
      'doc-3',
      'u',
      abort.signal,
      async () => {}
    )
  );
  t.is(f.writes.length, 0);
});

function providerFixture() {
  const state = {
    allowFolders: true,
    allowRead: true,
    allowWrite: true,
    fails: false,
    writes: 0,
  };
  const workspace = {
    assert: async () => {},
    doc: (id: string) => ({
      can: async (action: string) =>
        id.startsWith('db$')
          ? state.allowFolders
          : action === 'Doc.Read'
            ? state.allowRead
            : state.allowWrite,
      assert: async (action: string) => {
        if (!(await workspace.doc(id).can(action))) throw new Error('denied');
      },
    }),
    docs: async (docs: { docId: string }[]) => {
      if (state.fails) throw new Error('PRIVATE_BACKEND_DETAILS');
      return docs.filter(doc => doc.docId === 'visible');
    },
  };
  const provider = new WorkspaceMcpProvider(
    { user: () => ({ workspace: () => workspace }) } as never,
    {} as never,
    {
      addDocMention: async (
        _ws: string,
        _parent: string,
        _child: string,
        _user: string,
        _signal: AbortSignal,
        authorize: () => Promise<void>
      ) => {
        await authorize();
        state.writes++;
        return { added: true };
      },
    } as never,
    {} as never,
    {} as never,
    undefined as never,
    {
      list: async () => [
        {
          id: 'folder',
          name: 'Folder',
          parentId: null,
          docIds: ['visible', 'secret'],
        },
      ],
      addDoc: async (
        _ws: string,
        _folder: string,
        _doc: string,
        _user: string,
        _signal: AbortSignal,
        authorize: () => Promise<void>
      ) => {
        await authorize();
        state.writes++;
        return { added: true };
      },
    } as never
  );
  return { state, provider };
}

test('MCP list_folders filters private doc identifiers and fails closed', async t => {
  const { state, provider } = providerFixture();
  const server = await provider.for('u', 'ws');
  const tool = server.tools.find(tool => tool.name === 'list_folders')!;
  const result = await tool.execute({}, { signal });
  t.falsy(result.isError);
  t.deepEqual(JSON.parse(result.content[0].text).folders[0].docIds, [
    'visible',
  ]);
  t.false(JSON.stringify(result).includes('secret'));
  state.fails = true;
  const failed = await tool.execute({}, { signal });
  t.true(failed.isError);
  t.false(JSON.stringify(failed).includes('PRIVATE_BACKEND_DETAILS'));
  state.allowFolders = false;
  t.true((await tool.execute({}, { signal })).isError);
});

test.serial(
  'MCP folder and child tools enforce credential mode, permission and cancellation',
  async t => {
    const descriptor = Object.getOwnPropertyDescriptor(env, 'mcpWriteEnabled');
    let enabled = true;
    Object.defineProperty(env, 'mcpWriteEnabled', {
      configurable: true,
      get: () => enabled,
    });
    t.teardown(() => {
      if (descriptor) Object.defineProperty(env, 'mcpWriteEnabled', descriptor);
      else Reflect.deleteProperty(env, 'mcpWriteEnabled');
    });
    const { state, provider } = providerFixture();
    const ro = await provider.for('u', 'ws', McpAccessMode.READ_ONLY);
    t.false(
      ro.tools.some(tool =>
        ['add_document_to_folder', 'add_child_document'].includes(tool.name)
      )
    );
    const rw = await provider.for('u', 'ws', McpAccessMode.READ_WRITE);
    for (const [name, args] of [
      ['add_document_to_folder', { docId: 'visible', folderId: 'folder' }],
      ['add_child_document', { parentDocId: 'parent', childDocId: 'visible' }],
    ] as const) {
      const tool = rw.tools.find(tool => tool.name === name)!;
      state.allowRead = false;
      t.true((await tool.execute(args, { signal })).isError);
      state.allowRead = true;
      t.falsy((await tool.execute(args, { signal })).isError);
      const abort = new AbortController();
      abort.abort();
      t.true((await tool.execute(args, { signal: abort.signal })).isError);
    }
    t.is(state.writes, 2);
    const child = rw.tools.find(tool => tool.name === 'add_child_document')!;
    t.true(
      (
        await child.execute(
          { parentDocId: 'same', childDocId: 'same' },
          { signal }
        )
      ).isError
    );
    state.allowWrite = false;
    t.true(
      (
        await child.execute(
          { parentDocId: 'parent', childDocId: 'visible' },
          { signal }
        )
      ).isError
    );
    const folder = rw.tools.find(
      tool => tool.name === 'add_document_to_folder'
    )!;
    state.allowFolders = false;
    t.true(
      (
        await folder.execute(
          { docId: 'visible', folderId: 'folder' },
          { signal }
        )
      ).isError
    );
    state.allowWrite = true;
    state.allowFolders = true;
    enabled = false;
    t.true(
      (
        await child.execute(
          { parentDocId: 'parent', childDocId: 'visible' },
          { signal }
        )
      ).isError
    );
    t.true(
      (
        await folder.execute(
          { docId: 'visible', folderId: 'folder' },
          { signal }
        )
      ).isError
    );
    t.is(state.writes, 2);
  }
);
