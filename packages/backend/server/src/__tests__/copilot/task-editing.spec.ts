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
  };
  const row = {
    id: 'task',
    title: 'Shared work',
    description: 'Before',
    assigneeId: 'user',
    canEdit: true,
    updatedAt: 1000,
    status: 'ready',
    blockedReason: '',
  };
  const writes: unknown[][] = [];
  const tasks = {
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
  return { service, tasks, flags, entries, row, writes, proposal };
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
    tasks as never
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
    } as never
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
