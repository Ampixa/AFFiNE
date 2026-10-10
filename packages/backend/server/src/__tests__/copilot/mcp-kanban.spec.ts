import { McpAccessMode } from '@prisma/client';
import test from 'ava';
import * as Y from 'yjs';

import type { EventBus, Mutex } from '../../base';
import type { DocReader, DocWriter } from '../../core/doc';
import type { PgWorkspaceDocStorageAdapter } from '../../core/doc/adapters/workspace';
import { KanbanService } from '../../core/doc/kanban';
import { KanbanDocument } from '../../core/doc/kanban-document';
import type { PermissionAccess } from '../../core/permission';
import { WorkspaceMcpProvider } from '../../plugins/copilot/mcp/provider';
import type { DocumentRetrievalService } from '../../plugins/copilot/retrieval/document';

// The nested Yjs representation produced by BlockSuite's native2Y serializer.
function nested(value: unknown): unknown {
  if (Array.isArray(value)) {
    const array = new Y.Array();
    array.push(value.map(nested));
    return array;
  }
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Y.AbstractType)
  ) {
    return new Y.Map(Object.entries(value).map(([key, v]) => [key, nested(v)]));
  }
  return value;
}

function document() {
  const doc = new Y.Doc();
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  for (const taskId of ['row-a', 'row-b', 'outside']) {
    blocks.set(
      taskId,
      nested({
        'sys:id': taskId,
        'sys:flavour': 'affine:paragraph',
        'sys:version': 1,
        'sys:children': [],
        'prop:type': 'text',
        'prop:text': new Y.Text(taskId),
      }) as Y.Map<unknown>
    );
  }
  blocks.set(
    'board',
    nested({
      'sys:id': 'board',
      'sys:flavour': 'affine:database',
      'sys:version': 3,
      'sys:children': ['row-a', 'row-b'],
      'prop:title': new Y.Text('Release tasks'),
      'prop:columns': [
        { id: 'title-id', type: 'title', name: 'Title', data: {} },
        {
          id: 'status',
          type: 'select',
          name: 'Status',
          data: {
            options: [
              { id: 'todo', value: 'Todo', color: 'grey' },
              { id: 'done', value: 'Done', color: 'green' },
            ],
          },
        },
      ],
      'prop:views': [
        { id: 'table', name: 'Table', mode: 'table' },
        {
          id: 'kanban',
          name: 'Delivery',
          mode: 'kanban',
          groupBy: { columnId: 'status', name: 'select', hideEmpty: false },
          filter: { type: 'group', op: 'and', conditions: [] },
          header: { titleColumn: 'title-id', iconColumn: 'type' },
          groupProperties: [{ key: 'todo', manuallyCardSort: ['row-a'] }],
        },
      ],
      'prop:cells': {
        'row-a': {
          status: { columnId: 'status', value: 'todo' },
          priority: { columnId: 'priority', value: 'urgent' },
        },
      },
    }) as Y.Map<unknown>
  );
  blocks.set(
    'note',
    nested({
      'sys:id': 'note',
      'sys:flavour': 'affine:note',
      'sys:version': 1,
      'sys:children': ['board', 'outside'],
    }) as Y.Map<unknown>
  );
  blocks.set(
    'page',
    nested({
      'sys:id': 'page',
      'sys:flavour': 'affine:page',
      'sys:version': 2,
      'sys:children': ['note'],
      'prop:title': new Y.Text('Project'),
    }) as Y.Map<unknown>
  );
  return doc;
}

function fixture(
  options: { missing?: boolean; reject?: boolean; busy?: boolean } = {}
) {
  const stored = document();
  const events: unknown[][] = [];
  const writes: unknown[][] = [];
  const reads: unknown[][] = [];
  const locks: string[] = [];
  let previous = Promise.resolve();
  const service = new KanbanService(
    {
      getDoc: async (...args: unknown[]) => {
        reads.push(args);
        // Real storage is asynchronous: keep this boundary to catch early unlocks.
        await Promise.resolve();
        return options.missing ? null : { bin: Y.encodeStateAsUpdate(stored) };
      },
      pushDocUpdates: async (...args: unknown[]) => {
        writes.push(args);
        await Promise.resolve();
        if (options.reject) return 0;
        for (const update of args[2] as Uint8Array[])
          Y.applyUpdate(stored, update);
        return Date.now();
      },
    } as unknown as PgWorkspaceDocStorageAdapter,
    {
      emit: (...args: unknown[]) => events.push(args),
    } as unknown as EventBus,
    {
      acquire: async (key: string) => {
        locks.push(key);
        if (options.busy) return;
        const waiting = previous;
        let release!: () => void;
        previous = new Promise<void>(resolve => {
          release = resolve;
        });
        await waiting;
        return { [Symbol.asyncDispose]: async () => release() };
      },
    } as unknown as Mutex
  );
  const signal = new AbortController().signal;
  const read = () =>
    service.read('workspace', 'doc', signal, board =>
      board.readBoard('board', 'kanban')
    );
  const create = (requestId = 'request-1', title = 'Ship release') =>
    service.write('workspace', 'doc', 'editor', signal, board =>
      board.createTask('board', 'kanban', title, 'todo', requestId, 'editor')
    );
  const move = (taskId: string, columnId: string | null) =>
    service.write('workspace', 'doc', 'editor', signal, board =>
      board.moveTask('board', 'kanban', taskId, columnId, 'editor')
    );
  return {
    service,
    stored,
    events,
    writes,
    reads,
    locks,
    signal,
    read,
    create,
    move,
  };
}

test('discover and paginate Kanban rows, including ungrouped tasks', t => {
  const doc = document();
  t.teardown(() => doc.destroy());
  const board = new KanbanDocument(doc);
  t.deepEqual(
    board.listBoards().boards.map(b => [b.blockId, b.viewId, b.supported]),
    [['board', 'kanban', true]]
  );
  const first = board.readBoard('board', 'kanban', 0, 1);
  t.is(first.nextOffset, 1);
  t.is(first.total, 2);
  t.is(first.tasks[0].columnId, 'todo');
  t.is(board.readBoard('board', 'kanban', 1, 1).tasks[0].columnId, null);
  t.false(first.filtersApplied);
  t.deepEqual(
    first.columns.map(c => c.columnId),
    [null, 'todo', 'done']
  );
});

test('create and move persist Yjs deltas with attribution and update events', async t => {
  const f = fixture();
  t.teardown(() => f.stored.destroy());
  const created = await f.create();
  t.true(created.created);
  await f.move(created.taskId, 'done');
  const result = await f.read();
  t.is(result.total, 3);
  t.deepEqual(result.tasks[2], {
    taskId: created.taskId,
    title: 'Ship release',
    columnId: 'done',
  });
  const blocks = f.stored.getMap<Y.Map<unknown>>('blocks');
  t.is(blocks.get(created.taskId)!.get('prop:meta:createdBy'), 'editor');
  t.is(blocks.get(created.taskId)!.get('prop:meta:updatedBy'), 'editor');
  t.true(blocks.get(created.taskId)!.get('prop:text') instanceof Y.Text);
  t.is(f.writes.length, 2);
  t.deepEqual(f.writes[0].slice(0, 2), ['workspace', 'doc']);
  t.is(f.writes[0][3], 'editor');
  t.is(f.events.length, 2);
  t.like(f.events[1], [
    'doc.updates.pushed',
    { spaceId: 'workspace', docId: 'doc', editor: 'editor' },
  ]);
});

test('moving status preserves other cells, title, views and concurrent text edits', async t => {
  const f = fixture();
  t.teardown(() => f.stored.destroy());
  const browser = new Y.Doc();
  t.teardown(() => browser.destroy());
  Y.applyUpdate(browser, Y.encodeStateAsUpdate(f.stored));
  const original = f.stored
    .getMap<Y.Map<unknown>>('blocks')
    .get('board')!
    .toJSON();
  (
    browser
      .getMap<Y.Map<unknown>>('blocks')
      .get('row-a')!
      .get('prop:text') as Y.Text
  ).insert(5, ' edited in browser');
  await f.move('row-a', 'done');
  Y.applyUpdate(f.stored, Y.encodeStateAsUpdate(browser));
  const result = await f.read();
  t.is(result.tasks[0].title, 'row-a edited in browser');
  t.is(result.tasks[0].columnId, 'done');
  const current = f.stored
    .getMap<Y.Map<unknown>>('blocks')
    .get('board')!
    .toJSON();
  t.deepEqual(current['prop:views'], original['prop:views']);
  t.deepEqual(
    current['prop:cells']['row-a'].priority,
    original['prop:cells']['row-a'].priority
  );
  t.deepEqual(current['sys:children'], original['sys:children']);
  await f.move('row-a', null);
  t.is((await f.read()).tasks[0].columnId, null);
});

test('simultaneous create retries create exactly one task and release the mutex after persistence', async t => {
  const f = fixture();
  t.teardown(() => f.stored.destroy());
  const results = await Promise.all([f.create(), f.create()]);
  t.is(results[0].taskId, results[1].taskId);
  t.deepEqual(
    results.map(r => r.created),
    [true, false]
  );
  t.is(f.writes.length, 1);
  t.deepEqual(f.locks, [
    'mcp:kanban:workspace:doc',
    'mcp:kanban:workspace:doc',
  ]);
  await f.move(results[0].taskId, 'done');
  const retry = await f.create();
  t.false(retry.created);
  t.is(retry.columnId, 'done');
  await t.throwsAsync(f.create('request-1', 'Different task'), {
    message: /REQUEST_ID_CONFLICT/,
  });
  t.is((await f.read()).total, 3);
});

test('same-column moves are no-ops and foreign rows or columns never write', async t => {
  const f = fixture();
  t.teardown(() => f.stored.destroy());
  t.false((await f.move('row-a', 'todo')).moved);
  await t.throwsAsync(f.move('outside', 'done'), { message: /TASK_NOT_FOUND/ });
  await t.throwsAsync(f.move('row-a', 'not-a-status'), {
    message: /COLUMN_NOT_FOUND/,
  });
  t.is(f.writes.length, 0);
  t.is(f.events.length, 0);
});

for (const [label, configure, expected] of [
  [
    'filtered view',
    (b: Y.Map<unknown>, v: Y.Map<unknown>) =>
      v.set('filter', nested({ conditions: [{}] })),
    /FILTERED_BOARD/,
  ],
  [
    'hidden destination',
    (b: Y.Map<unknown>, v: Y.Map<unknown>) =>
      v.set('groupProperties', nested([{ key: 'todo', hide: true }])),
    /HIDDEN_COLUMN/,
  ],
  [
    'custom card heading',
    (b: Y.Map<unknown>, v: Y.Map<unknown>) =>
      v.set('header', nested({ titleColumn: 'status' })),
    /UNSUPPORTED_BOARD/,
  ],
  [
    'multi-select grouping',
    (b: Y.Map<unknown>, v: Y.Map<unknown>) =>
      v.set('groupBy', nested({ columnId: 'status', name: 'multi-select' })),
    /UNSUPPORTED_BOARD/,
  ],
  [
    'new schema version',
    (b: Y.Map<unknown>) => b.set('sys:version', 99),
    /UNSUPPORTED_BOARD/,
  ],
] as const) {
  test(`reject ${label} without changing stored content`, async t => {
    const f = fixture();
    t.teardown(() => f.stored.destroy());
    const block = f.stored.getMap<Y.Map<unknown>>('blocks').get('board')!;
    const view = (block.get('prop:views') as Y.Array<Y.Map<unknown>>).get(1);
    configure(block, view);
    const before = Y.encodeStateAsUpdate(f.stored);
    await t.throwsAsync(f.create(), { message: expected });
    t.deepEqual(Y.encodeStateAsUpdate(f.stored), before);
    t.is(f.writes.length, 0);
  });
}

test('filtered boards can still be read with explicit filter disclosure', async t => {
  const f = fixture();
  t.teardown(() => f.stored.destroy());
  const block = f.stored.getMap<Y.Map<unknown>>('blocks').get('board')!;
  (block.get('prop:views') as Y.Array<Y.Map<unknown>>)
    .get(1)
    .set('filter', nested({ conditions: [{}] }));
  const result = await f.read();
  t.true(result.hasViewFilter);
  t.false(result.filtersApplied);
  t.is(result.scope, 'all_database_rows');
});

for (const [options, expected] of [
  [{ missing: true }, /DOCUMENT_NOT_FOUND/],
  [{ reject: true }, /WRITE_FAILED/],
  [{ busy: true }, /BOARD_BUSY/],
] as const) {
  test(`storage failure is not reported as a successful change: ${expected}`, async t => {
    const f = fixture(options);
    t.teardown(() => f.stored.destroy());
    await t.throwsAsync(f.create(), { message: expected });
    t.is(f.events.length, 0);
    t.is(new KanbanDocument(f.stored).readBoard('board', 'kanban').total, 2);
  });
}

test('aborted or partially failing actions cannot persist changes', async t => {
  const f = fixture();
  t.teardown(() => f.stored.destroy());
  const abort = new AbortController();
  abort.abort();
  await t.throwsAsync(
    f.service.read('workspace', 'doc', abort.signal, b => b.listBoards())
  );
  t.is(f.reads.length, 0);
  await t.throwsAsync(
    f.service.write('workspace', 'doc', 'editor', f.signal, b => {
      b.createTask(
        'board',
        'kanban',
        'Temporary',
        'todo',
        'test-fail',
        'editor'
      );
      throw new Error('cancel action');
    }),
    { message: 'cancel action' }
  );
  t.is(f.writes.length, 0);
  t.is((await f.read()).total, 2);
});

function providerFixture(
  options: { denied?: boolean; workspaceDenied?: boolean; fail?: boolean } = {}
) {
  const f = fixture();
  const permissionCalls: unknown[][] = [];
  const provider = new WorkspaceMcpProvider(
    {
      user: (userId: string) => ({
        workspace: (workspaceId: string) => ({
          assert: async () => {
            if (options.workspaceDenied) throw new Error('Denied');
          },
          doc: (docId: string) => ({
            can: async (action: string) => {
              permissionCalls.push([userId, workspaceId, docId, action]);
              return !options.denied;
            },
          }),
        }),
      }),
    } as unknown as PermissionAccess,
    {} as DocReader,
    {} as DocWriter,
    {} as DocumentRetrievalService,
    options.fail
      ? ({
          read: async () => {
            throw new Error('SECRET_BACKEND_DETAILS');
          },
        } as unknown as KanbanService)
      : f.service
  );
  return { ...f, provider, permissionCalls };
}

// Serial because the existing server feature flag is global.
test.serial(
  'MCP tools enforce access, input validation and live write gate',
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
    const f = providerFixture();
    t.teardown(() => f.stored.destroy());
    const ro = await f.provider.for('editor', 'workspace');
    t.false(ro.tools.some(tool => tool.name === 'create_kanban_task'));
    t.true(ro.tools.some(tool => tool.name === 'read_kanban_board'));
    const rw = await f.provider.for(
      'editor',
      'workspace',
      McpAccessMode.READ_WRITE
    );
    const create = rw.tools.find(tool => tool.name === 'create_kanban_task')!;
    const read = rw.tools.find(tool => tool.name === 'read_kanban_board')!;
    const args = {
      docId: 'doc',
      blockId: 'board',
      viewId: 'kanban',
      columnId: 'todo',
      title: 'Test',
      requestId: 'request-1',
    };
    for (const bad of [
      { ...args, title: ' ' },
      { ...args, requestId: 'x' },
      { ...args, unknown: 'x' },
      { ...args, columnId: undefined },
    ]) {
      t.true((await create.execute(bad, { signal: f.signal })).isError);
    }
    const abort = new AbortController();
    abort.abort();
    t.true((await create.execute(args, { signal: abort.signal })).isError);
    t.is(f.permissionCalls.length, 0);
    const created = await create.execute(args, { signal: f.signal });
    t.falsy(created.isError);
    const taskId = JSON.parse(created.content[0].text).taskId;
    t.deepEqual(f.permissionCalls[0], [
      'editor',
      'workspace',
      'doc',
      'Doc.Update',
    ]);
    const move = rw.tools.find(tool => tool.name === 'move_kanban_task')!;
    t.falsy(
      (
        await move.execute(
          {
            docId: 'doc',
            blockId: 'board',
            viewId: 'kanban',
            taskId,
            columnId: 'done',
          },
          { signal: f.signal }
        )
      ).isError
    );
    const result = await read.execute(
      { docId: 'doc', blockId: 'board', viewId: 'kanban', limit: 1 },
      { signal: f.signal }
    );
    t.is(JSON.parse(result.content[0].text).nextOffset, 1);
    t.deepEqual(f.permissionCalls.at(-1), [
      'editor',
      'workspace',
      'doc',
      'Doc.Read',
    ]);
    const denied = providerFixture({ denied: true });
    t.teardown(() => denied.stored.destroy());
    const deniedServer = await denied.provider.for(
      'editor',
      'workspace',
      McpAccessMode.READ_WRITE
    );
    const deniedCreate = deniedServer.tools.find(
      tool => tool.name === 'create_kanban_task'
    )!;
    t.true((await deniedCreate.execute(args, { signal: f.signal })).isError);
    t.is(denied.reads.length, 0);
    t.is(denied.writes.length, 0);
    enabled = false;
    t.true(
      (
        await create.execute(
          { ...args, requestId: 'request-2' },
          { signal: f.signal }
        )
      ).isError
    );
    const disabled = await f.provider.for(
      'editor',
      'workspace',
      McpAccessMode.READ_WRITE
    );
    t.false(disabled.tools.some(tool => tool.name === 'move_kanban_task'));
    t.is(f.writes.length, 2);
  }
);

test.serial(
  'MCP denial does not access storage and unknown errors are sanitized',
  async t => {
    for (const options of [{ denied: true }, { fail: true }]) {
      const f = providerFixture(options);
      t.teardown(() => f.stored.destroy());
      const server = await f.provider.for('editor', 'workspace');
      const tool = server.tools.find(
        tool => tool.name === 'list_kanban_boards'
      )!;
      const result = await tool.execute({ docId: 'doc' }, { signal: f.signal });
      t.true(result.isError);
      t.false(result.content[0].text.includes('SECRET_BACKEND_DETAILS'));
      t.is(f.reads.length, 0);
    }
    const denied = providerFixture({ workspaceDenied: true });
    t.teardown(() => denied.stored.destroy());
    await t.throwsAsync(denied.provider.for('editor', 'workspace'), {
      message: 'Denied',
    });
    t.is(denied.reads.length, 0);
  }
);
