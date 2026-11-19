// Match runtime initialization order for circular copilot provider dependencies.
import '../../plugins/copilot/runtime/capability-runtime';

import { McpAccessMode } from '@prisma/client';
import test from 'ava';

import type { Cache } from '../../base';
import type { WorkspaceTasksService } from '../../core/workspaces/tasks';
import type { Models } from '../../models';
import { CopilotController } from '../../plugins/copilot/controller';
import { WorkspaceMcpProvider } from '../../plugins/copilot/mcp/provider';
import { TaskEditing } from '../../plugins/copilot/runtime/task-editing';

function fixture() {
  const entries = new Map<string, unknown>();
  const flags = {
    ai: true,
    session: true,
    access: true,
    cache: true,
    receipt: true,
    fails: false,
    canCreate: true,
    docRead: true,
    admin: false,
  };
  const row = {
    id: 'task',
    title: 'Shared work',
    description: 'Before',
    assigneeId: 'user',
    canEdit: true,
    canLink: true,
    linkedDocIds: [] as string[],
    updatedAt: 1000,
    status: 'ready',
    blockedReason: '',
  };
  const writes: unknown[][] = [];
  const creates: any[][] = [];
  const links: any[][] = [];
  let beforeWrite = () => {};
  const prepareCreate = async (user: string, ws: string, input: any) => {
    if (!flags.access || !flags.canCreate || ws !== 'workspace')
      throw new Error('Creation unavailable');
    if (
      !flags.admin &&
      ((input.assigneeId !== undefined && input.assigneeId !== user) ||
        (input.priority && input.priority !== 'normal') ||
        input.dueDate)
    )
      throw new Error('Forbidden initial fields');
    if ((input.linkedDocIds?.length ?? 0) && !flags.docRead)
      throw new Error('Document unavailable');
    return {
      data: {
        title: input.title,
        description: '',
        status: 'inbox',
        priority: 'normal',
        blockedReason: '',
        ...input,
        assigneeId: input.assigneeId ?? user,
      },
      ids: input.linkedDocIds ?? [],
    };
  };
  const prepareLink = async (
    user: string,
    ws: string,
    id: string,
    docId: string
  ) => {
    if (
      !flags.access ||
      ws !== 'workspace' ||
      id !== 'task' ||
      !row.canLink ||
      (!flags.admin && row.assigneeId !== user) ||
      !flags.docRead ||
      docId !== 'doc'
    )
      throw new Error('Link unavailable');
    return { ...row };
  };
  const tasks = {
    prepareCreate,
    prepareLink,
    create: async (...args: any[]) => {
      beforeWrite();
      if (flags.fails) throw new Error('Ambiguous create');
      const [user, ws, input] = args;
      const prepared = await prepareCreate(user, ws, input);
      creates.push(args);
      return { id: 'created-task', ...prepared.data };
    },
    link: async (...args: any[]) => {
      beforeWrite();
      if (flags.fails) throw new Error('Ambiguous link');
      const [user, ws, id, docId, remove, expectedUpdatedAt] = args;
      await prepareLink(user, ws, id, docId);
      if (expectedUpdatedAt !== row.updatedAt) throw new Error('Stale link');
      links.push(args);
      row.linkedDocIds = remove ? [] : [docId];
      row.updatedAt++;
      return { ...row };
    },
    get: async (_user: string, ws: string, id: string) => {
      if (!flags.access || ws !== 'workspace' || id !== 'task')
        throw new Error('Not accessible');
      return { ...row };
    },
    list: async () => ({ tasks: [{ ...row }], nextCursor: null }),
    update: async (...args: any[]) => {
      const [user, ws, id, patch, assignedOnly] = args;
      if (flags.fails) throw new Error('Ambiguous backend failure');
      if (
        !flags.access ||
        !row.canEdit ||
        row.assigneeId !== user ||
        !assignedOnly ||
        patch.expectedUpdatedAt !== row.updatedAt ||
        ws !== 'workspace' ||
        id !== 'task'
      )
        throw new Error('Stale or forbidden');
      writes.push(args);
      Object.assign(row, patch, { updatedAt: row.updatedAt + 1 });
      return row;
    },
  } as unknown as WorkspaceTasksService;
  const cache = {
    increaseWithTtl: async (key: string) => {
      if (!flags.cache) return 0;
      const count = Number(entries.get(key) ?? 0) + 1;
      entries.set(key, count);
      return count;
    },
    get: async (key: string) => entries.get(key),
    has: async (key: string) => entries.has(key),
    set: async (key: string, value: unknown) => {
      if (!flags.cache || (key.endsWith(':receipt') && !flags.receipt))
        return false;
      entries.set(key, value);
      return true;
    },
    setnx: async (key: string, value: unknown) => {
      if (!flags.cache || entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
  } as unknown as Cache;
  const models = {
    workspace: { get: async () => ({ enableAi: flags.ai }) },
    copilotSession: {
      has: async (
        session: string,
        user: string,
        options: { workspaceId: string }
      ) =>
        flags.session &&
        session === 'session' &&
        user === 'user' &&
        options.workspaceId === 'workspace',
    },
  } as unknown as Models;
  const service = new TaskEditing(tasks, cache, models);
  const proposal = () =>
    service.propose('user', 'workspace', 'session', 'task', {
      description: 'After',
    });
  return {
    service,
    tasks,
    flags,
    entries,
    row,
    writes,
    creates,
    links,
    proposal,
    atWrite: (fn: () => void) => {
      beforeWrite = fn;
    },
  };
}

test('task Intelligence exposes read/list/proposal only and proposal does not write', async t => {
  const f = fixture();
  t.deepEqual(f.service.tools(undefined), {});
  const tools = f.service.tools({
    user: 'user',
    workspace: 'workspace',
    session: 'session',
  });
  t.deepEqual(Object.keys(tools).sort(), [
    'task_comments',
    'task_create',
    'task_link_document',
    'task_list',
    'task_read',
    'task_update',
  ]);
  const p = await f.proposal();
  t.is(p.status, 'proposed');
  t.is(f.row.description, 'Before');
  t.deepEqual(f.writes, []);
  t.is(
    (await f.service.decide('user', p.proposalId, 'status')).status,
    'proposed'
  );
  t.is(
    (await f.service.decide('user', p.proposalId, 'apply')).status,
    'applied'
  );
  t.is(f.row.description, 'After');
  t.is(f.writes.length, 1);
  t.is(f.writes[0][4], true);
  await f.service.decide('user', p.proposalId, 'apply');
  t.is(f.writes.length, 1);
});

test('task preview cancellation never writes and cannot later be applied', async t => {
  const f = fixture();
  const p = await f.proposal();
  t.is(
    (await f.service.decide('user', p.proposalId, 'cancel')).status,
    'cancelled'
  );
  t.is(
    (await f.service.decide('user', p.proposalId, 'apply')).status,
    'cancelled'
  );
  t.deepEqual(f.writes, []);
});

test('administrative task fields and empty patches cannot be proposed', async t => {
  const f = fixture();
  for (const patch of [
    {},
    { assigneeId: 'other' },
    { priority: 'urgent' },
    { dueDate: '2026-11-22' },
    { archived: true },
    { title: 'Other title' },
    { description: 'Allowed', status: 'invalid' },
  ]) {
    await t.throwsAsync(() =>
      f.service.propose('user', 'workspace', 'session', 'task', patch)
    );
  }
  t.deepEqual(f.writes, []);
  t.is(f.entries.size, 0);
});

test('admin ability does not bypass assigned-owner rule in Intelligence', async t => {
  const f = fixture();
  f.row.assigneeId = 'other';
  f.row.canEdit = true;
  await t.throwsAsync(f.proposal);
  t.is(f.entries.size, 0);
});

for (const cause of [
  'owner',
  'permission',
  'session',
  'workspace-ai',
  'membership',
] as const) {
  test(`task Apply rejects ${cause} changes while preview is open`, async t => {
    const f = fixture();
    const p = await f.proposal();
    if (cause === 'owner') f.row.assigneeId = 'other';
    if (cause === 'permission') f.row.canEdit = false;
    if (cause === 'session') f.flags.session = false;
    if (cause === 'workspace-ai') f.flags.ai = false;
    if (cause === 'membership') f.flags.access = false;
    await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
    t.deepEqual(f.writes, []);
    t.is(f.row.description, 'Before');
  });
}

test('task preview belongs to its user and expires', async t => {
  const f = fixture();
  const p = await f.proposal();
  await t.throwsAsync(() => f.service.decide('other', p.proposalId, 'apply'));
  (
    f.entries.get(`copilot:task-edit:${p.proposalId}`) as { expiresAt: number }
  ).expiresAt = Date.now() - 1;
  await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
  t.deepEqual(f.writes, []);
});

test('stale task edit is not overwritten and uncertain writes cannot be replayed', async t => {
  const f = fixture();
  const p = await f.proposal();
  f.row.updatedAt++;
  await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
  t.is(
    (await f.service.decide('user', p.proposalId, 'status')).status,
    'uncertain'
  );
  await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
  t.deepEqual(f.writes, []);
});

test('preview cache failures and missing receipt do not cause duplicate writes', async t => {
  const f = fixture();
  f.flags.cache = false;
  await t.throwsAsync(f.proposal);
  t.deepEqual(f.writes, []);
  f.flags.cache = true;
  const p = await f.proposal();
  f.flags.receipt = false;
  await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
  t.is(f.writes.length, 1);
  await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
  t.is(f.writes.length, 1);
});

test('task apply endpoint accepts only a decision and requires a non-simple header', async t => {
  const f = fixture();
  const p = await f.proposal();
  const controller = new CopilotController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    f.service
  );
  await t.throwsAsync(() =>
    controller.decideTaskEdit({ id: 'user' } as never, p.proposalId, '', {
      decision: 'apply',
    })
  );
  await t.throwsAsync(() =>
    controller.decideTaskEdit({ id: 'user' } as never, p.proposalId, '1', {
      decision: 'apply',
      patch: { title: 'Injected' },
    })
  );
  t.deepEqual(f.writes, []);
});

test('read-only MCP has task discovery but no mutations and binds actor to authenticated context', async t => {
  const calls: unknown[][] = [];
  const tasks = {
    list: async (...args: unknown[]) => {
      calls.push(args);
      return { tasks: [], nextCursor: null };
    },
  };
  const provider = new WorkspaceMcpProvider(
    {
      user: () => ({ workspace: () => ({ assert: async () => {} }) }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    tasks as never,
    {} as never
  );
  const server = await provider.for(
    'authenticated-member',
    'workspace',
    McpAccessMode.READ_ONLY
  );
  t.truthy(server.tools.find(tool => tool.name === 'read_task'));
  for (const name of [
    'create_task',
    'update_task',
    'link_task_document',
    'add_task_comment',
    'edit_task_comment',
  ])
    t.falsy(server.tools.find(tool => tool.name === name));
  const tool = server.tools.find(tool => tool.name === 'list_tasks')!;
  const signal = new AbortController().signal;
  t.true((await tool.execute({ userId: 'admin' }, { signal })).isError);
  t.falsy((await tool.execute({}, { signal })).isError);
  t.deepEqual(calls[0], ['authenticated-member', 'workspace', undefined, '50']);
});

test('concurrent Apply requests write at most once', async t => {
  const f = fixture();
  const p = await f.proposal();
  const results = await Promise.allSettled([
    f.service.decide('user', p.proposalId, 'apply'),
    f.service.decide('user', p.proposalId, 'apply'),
  ]);
  t.true(results.some(result => result.status === 'fulfilled'));
  t.is(f.writes.length, 1);
});

test('task proposal rate limit bounds stored previews', async t => {
  const f = fixture();
  for (let i = 0; i < 20; i++) await f.proposal();
  await t.throwsAsync(f.proposal);
  t.is(
    [...f.entries.keys()].filter(key => !key.includes(':limit:')).length,
    20
  );
  t.deepEqual(f.writes, []);
});

test('MCP pre-aborted task request never executes the service', async t => {
  let called = false;
  const provider = new WorkspaceMcpProvider(
    {
      user: () => ({ workspace: () => ({ assert: async () => {} }) }),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      list: async () => {
        called = true;
      },
    } as never,
    {} as never
  );
  const server = await provider.for(
    'user',
    'workspace',
    McpAccessMode.READ_ONLY
  );
  const abort = new AbortController();
  abort.abort();
  const result = await server.tools
    .find(tool => tool.name === 'list_tasks')!
    .execute({}, { signal: abort.signal });
  t.true(result.isError);
  t.false(called);
});

for (const operation of ['create', 'link'] as const) {
  const propose = (f: ReturnType<typeof fixture>) =>
    operation === 'create'
      ? f.service.proposeCreate('user', 'workspace', 'session', {
          title: 'My next task',
        })
      : f.service.proposeLink('user', 'workspace', 'session', 'task', {
          docId: 'doc',
          linked: true,
        });
  test(`${operation} preview persists nothing until Apply and duplicate Apply is harmless`, async t => {
    const f = fixture();
    const p = await propose(f);
    t.is(p.status, 'proposed');
    t.is(f.creates.length + f.links.length, 0);
    const result = await f.service.decide('user', p.proposalId, 'apply');
    t.is(result.status, 'applied');
    t.is(f.creates.length + f.links.length, 1);
    await f.service.decide('user', p.proposalId, 'apply');
    t.is(f.creates.length + f.links.length, 1);
    if (operation === 'create') {
      t.is(f.creates[0][2].assigneeId, 'user');
      t.is('taskId' in result ? result.taskId : undefined, 'created-task');
    } else {
      t.is(f.links[0][4], false);
      t.is(f.links[0][5], 1000);
    }
  });
  test(`${operation} Cancel is durable and cannot later Apply`, async t => {
    const f = fixture();
    const p = await propose(f);
    t.is(
      (await f.service.decide('user', p.proposalId, 'cancel')).status,
      'cancelled'
    );
    t.is(
      (await f.service.decide('user', p.proposalId, 'apply')).status,
      'cancelled'
    );
    t.is(f.creates.length + f.links.length, 0);
  });
  test(`${operation} preview rejects wrong user and expiry`, async t => {
    const f = fixture();
    const p = await propose(f);
    await t.throwsAsync(() => f.service.decide('other', p.proposalId, 'apply'));
    (
      f.entries.get(`copilot:task-edit:${p.proposalId}`) as {
        expiresAt: number;
      }
    ).expiresAt = Date.now() - 1;
    await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
    t.is(f.creates.length + f.links.length, 0);
  });
  for (const cause of ['membership', 'session', 'ai', 'permission'] as const) {
    test(`${operation} Apply rejects revoked ${cause}`, async t => {
      const f = fixture();
      const p = await propose(f);
      if (cause === 'membership') f.flags.access = false;
      if (cause === 'session') f.flags.session = false;
      if (cause === 'ai') f.flags.ai = false;
      if (cause === 'permission') {
        f.flags.canCreate = false;
        f.row.canLink = false;
      }
      await t.throwsAsync(() =>
        f.service.decide('user', p.proposalId, 'apply')
      );
      t.is(f.creates.length + f.links.length, 0);
    });
  }
  test(`${operation} missing receipt cannot cause duplicate operation`, async t => {
    const f = fixture();
    const p = await propose(f);
    f.flags.receipt = false;
    await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
    t.is(f.creates.length + f.links.length, 1);
    await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
    t.is(f.creates.length + f.links.length, 1);
  });
  test(`${operation} ambiguous service failure cannot be retried`, async t => {
    const f = fixture();
    const p = await propose(f);
    f.flags.fails = true;
    await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
    f.flags.fails = false;
    t.is(
      (await f.service.decide('user', p.proposalId, 'status')).status,
      'uncertain'
    );
    await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
    t.is(f.creates.length + f.links.length, 0);
  });
  test(`${operation} concurrent Apply writes once`, async t => {
    const f = fixture();
    const p = await propose(f);
    await Promise.allSettled([
      f.service.decide('user', p.proposalId, 'apply'),
      f.service.decide('user', p.proposalId, 'apply'),
    ]);
    t.is(f.creates.length + f.links.length, 1);
  });
}

test('Intelligence member creation rejects another assignee and inaccessible initial links', async t => {
  const f = fixture();
  await t.throwsAsync(() =>
    f.service.proposeCreate('user', 'workspace', 'session', {
      title: 'Not mine',
      assigneeId: 'other',
    })
  );
  f.flags.docRead = false;
  await t.throwsAsync(() =>
    f.service.proposeCreate('user', 'workspace', 'session', {
      title: 'Private',
      linkedDocIds: ['doc'],
    })
  );
  t.is(f.creates.length, 0);
});

test('create Apply rechecks linked document access and role downgrade', async t => {
  const f = fixture();
  const p = await f.service.proposeCreate('user', 'workspace', 'session', {
    title: 'Source',
    linkedDocIds: ['doc'],
  });
  f.flags.docRead = false;
  await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
  t.is(f.creates.length, 0);
  const g = fixture();
  g.flags.admin = true;
  const other = await g.service.proposeCreate('user', 'workspace', 'session', {
    title: 'Assigned by admin',
    assigneeId: 'other',
  });
  g.flags.admin = false;
  await t.throwsAsync(() =>
    g.service.decide('user', other.proposalId, 'apply')
  );
  t.is(g.creates.length, 0);
});

test('link previews reject other-owner tasks and unreadable documents', async t => {
  const f = fixture();
  f.row.assigneeId = 'other';
  await t.throwsAsync(() =>
    f.service.proposeLink('user', 'workspace', 'session', 'task', {
      docId: 'doc',
      linked: true,
    })
  );
  f.row.assigneeId = 'user';
  f.flags.docRead = false;
  await t.throwsAsync(() =>
    f.service.proposeLink('user', 'workspace', 'session', 'task', {
      docId: 'doc',
      linked: true,
    })
  );
  t.is(f.links.length, 0);
});

for (const cause of ['owner', 'document', 'version', 'during-write'] as const) {
  test(`link Apply rejects changed ${cause}`, async t => {
    const f = fixture();
    const p = await f.service.proposeLink(
      'user',
      'workspace',
      'session',
      'task',
      { docId: 'doc', linked: true }
    );
    if (cause === 'owner') f.row.assigneeId = 'other';
    if (cause === 'document') f.flags.docRead = false;
    if (cause === 'version') f.row.updatedAt++;
    if (cause === 'during-write')
      f.atWrite(() => {
        f.row.assigneeId = 'other';
      });
    await t.throwsAsync(() => f.service.decide('user', p.proposalId, 'apply'));
    t.is(f.links.length, 0);
  });
}

test('unlink preview applies remove only after confirmation', async t => {
  const f = fixture();
  f.row.linkedDocIds = ['doc'];
  const p = await f.service.proposeLink(
    'user',
    'workspace',
    'session',
    'task',
    { docId: 'doc', linked: false }
  );
  t.deepEqual(f.row.linkedDocIds, ['doc']);
  await f.service.decide('user', p.proposalId, 'apply');
  t.is(f.links[0][4], true);
  t.deepEqual(f.row.linkedDocIds, []);
});
