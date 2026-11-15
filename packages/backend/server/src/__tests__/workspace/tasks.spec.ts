import type { PrismaClient, WorkspaceTask } from '@prisma/client';
import test from 'ava';
import type { Request } from 'express';
import { Array as YArray, Doc, encodeStateAsUpdate, Map } from 'yjs';

import { ActionForbidden } from '../../base';
import { mapAnyError } from '../../base/nestjs/exception';
import type { CurrentUser } from '../../core/auth';
import type { PgWorkspaceDocStorageAdapter } from '../../core/doc';
import type { PermissionAccess } from '../../core/permission';
import {
  WorkspaceTasksController,
  WorkspaceTasksService,
} from '../../core/workspaces/tasks';

function fixture() {
  const row: WorkspaceTask = {
    id: 'task',
    workspaceId: 'workspace',
    title: 'Public task',
    description: '',
    status: 'ready',
    priority: 'normal',
    archived: false,
    assigneeId: null,
    dueDate: null,
    blockedReason: '',
    legacyDocId: null,
    version: 1,
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
    createdBy: 'member',
    updatedBy: 'member',
  };
  let rows = [row];
  let links = [
    { taskId: 'task', docId: 'public-doc' },
    { taskId: 'task', docId: 'private-doc' },
  ];
  const history = [
    {
      id: 'event',
      taskId: 'task',
      actorId: 'member',
      body: 'Linked context document.',
      createdAt: new Date(1000),
    },
  ];
  const members = new Set(['member', 'reader']);
  const readable = new Set(['public-doc']);
  const snapshotIds = new Set(['public-doc', 'private-doc']);
  const pendingIds = new Set<string>();
  const editable = new Set(['public-doc']);
  const calls: string[] = [];
  const db = {
    snapshot: {
      findMany: async ({ where, select }: any) => {
        if (select.blob) throw new Error('No snapshot bytes allowed');
        return [...snapshotIds]
          .filter(id => where.id.in.includes(id))
          .map(id => ({ id }));
      },
    },
    update: {
      findMany: async ({ where, select }: any) => {
        if (select.blob) throw new Error('No update bytes allowed');
        return [...pendingIds]
          .filter(id => where.id.in.includes(id))
          .map(id => ({ id }));
      },
    },
    workspaceMember: {
      findFirst: async ({ where }: any) =>
        members.has(where.userId) && where.workspaceId === 'workspace'
          ? { id: 'membership' }
          : null,
    },
    workspaceTask: {
      findFirst: async ({ where }: any) =>
        rows.find(
          r => r.id === where.id && r.workspaceId === where.workspaceId
        ) || null,
      findMany: async ({ where, skip, take }: any) => {
        calls.push('task-query');
        return rows
          .filter(
            r =>
              r.workspaceId === where.workspaceId &&
              (!where.links ||
                links.some(
                  l => l.taskId === r.id && l.docId === where.links.some.docId
                ))
          )
          .slice(skip, skip + take)
          .map(r => ({ ...r, links: links.filter(l => l.taskId === r.id) }));
      },
      create: async ({ data }: any) => {
        calls.push('create');
        const created = { ...row, ...data, id: 'new-task' };
        rows.push(created);
        return created;
      },
      updateMany: async ({ where, data }: any) => {
        const current = rows.find(
          r =>
            r.id === where.id &&
            r.workspaceId === where.workspaceId &&
            r.version === where.version &&
            (!where.updatedAt ||
              r.updatedAt.getTime() === where.updatedAt.getTime())
        );
        if (!current) return { count: 0 };
        Object.assign(current, { ...data, version: current.version + 1 });
        return { count: 1 };
      },
    },
    workspaceDoc: {
      findMany: async ({ where }: any) => {
        calls.push('metadata-query');
        return ['public-doc', 'private-doc']
          .filter(id => !where.docId || where.docId.in.includes(id))
          .map(docId => ({
            docId,
            title: docId === 'private-doc' ? 'SECRET TITLE' : 'Readable source',
          }));
      },
      findUnique: async ({ where }: any) =>
        ['public-doc', 'private-doc'].includes(where.workspaceId_docId.docId)
          ? { blocked: false }
          : null,
    },
    taskDocumentLink: {
      findUnique: async ({ where }: any) =>
        links.find(
          l =>
            l.taskId === where.taskId_docId.taskId &&
            l.docId === where.taskId_docId.docId
        ) || null,
      findMany: async ({ where }: any) =>
        links.filter(l => l.taskId === where.taskId),
      count: async ({ where }: any) =>
        links.filter(l => l.taskId === where.taskId).length,
      upsert: async ({ create }: any) => {
        if (
          !links.some(
            l => l.taskId === create.taskId && l.docId === create.docId
          )
        )
          links.push(create);
      },
      deleteMany: async ({ where }: any) => {
        links = links.filter(
          l => l.taskId !== where.taskId || l.docId !== where.docId
        );
      },
    },
    taskActivity: {
      findMany: async () => history,
      create: async ({ data }: any) => {
        history.push({
          ...data,
          id: `event-${history.length}`,
          createdAt: new Date(),
        });
      },
    },
    $transaction: async (action: any) => action(db),
  };
  const ac = {
    user: (userId: string) => ({
      workspace: () => ({
        assert: async (action: string) => {
          if (action === 'Workspace.CreateDoc' && userId === 'reader')
            throw new ActionForbidden();
        },
        can: async () => userId !== 'reader',
      }),
      doc: (_workspace: string, docId: string) => ({
        can: async (action: string) =>
          (action === 'Doc.Update' ? editable : readable).has(docId),
      }),
    }),
  };
  const root = new Doc();
  const pages = new YArray();
  root.getMap('meta').set('pages', pages);
  for (const id of ['public-doc', 'private-doc']) {
    const page = new Map();
    page.set('id', id);
    pages.push([page]);
  }
  const storage = {
    getDocBinNative: async () => {
      calls.push('root-metadata');
      return encodeStateAsUpdate(root);
    },
  } as unknown as PgWorkspaceDocStorageAdapter;
  const service = new WorkspaceTasksService(
    db as unknown as PrismaClient,
    ac as unknown as PermissionAccess,
    storage
  );
  return {
    service,
    pages,
    snapshotIds,
    pendingIds,
    row,
    calls,
    readable,
    editable,
    history,
    setRows: (value: WorkspaceTask[]) => {
      rows = value;
    },
  };
}

test('workspace guests cannot list tasks even if they can read a shared document', async t => {
  const f = fixture();
  await t.throwsAsync(() => f.service.list('guest', 'workspace'), {
    instanceOf: ActionForbidden,
  });
  t.deepEqual(f.calls, []);
});

test('forged workspace cannot disclose a valid task ID', async t => {
  const f = fixture();
  await t.throwsAsync(() => f.service.get('member', 'foreign', 'task'));
  t.deepEqual(f.calls, []);
});

test('task list omits private link IDs and titles and does not scan snapshot storage', async t => {
  const f = fixture();
  const result = await f.service.list('member', 'workspace');
  t.deepEqual(result.tasks[0].linkedDocIds, ['public-doc']);
  t.is(result.linkedDocs.length, 1);
  t.false(JSON.stringify(result).includes('private-doc'));
  t.false(JSON.stringify(result).includes('SECRET TITLE'));
  t.deepEqual(f.calls, ['task-query', 'metadata-query']);
  t.deepEqual(result.tasks[0].history, []);
});

test('private legacy tasks remain hidden and pagination does not expose their identifiers', async t => {
  const f = fixture();
  f.row.legacyDocId = 'private-doc';
  const result = await f.service.list('member', 'workspace', undefined, '1');
  t.deepEqual(result.tasks, []);
  t.deepEqual(result.linkedDocs, []);
  t.is(result.nextCursor, '1');
  t.false(JSON.stringify(result).includes('private-doc'));
  await t.throwsAsync(() => f.service.get('member', 'workspace', 'task'));
});

test('legacy task readers cannot mutate despite workspace edit rights', async t => {
  const f = fixture();
  f.row.legacyDocId = 'public-doc';
  f.editable.delete('public-doc');
  t.false((await f.service.get('member', 'workspace', 'task')).canEdit);
  await t.throwsAsync(() =>
    f.service.update('member', 'workspace', 'task', {
      title: 'changed',
      expectedUpdatedAt: 1000,
    })
  );
  t.is(f.row.title, 'Public task');
});

test('active read-only member may list but cannot create or mutate', async t => {
  const f = fixture();
  t.false((await f.service.list('reader', 'workspace')).canCreate);
  await t.throwsAsync(() =>
    f.service.create('reader', 'workspace', { title: 'no' })
  );
  await t.throwsAsync(() =>
    f.service.update('reader', 'workspace', 'task', {
      title: 'no',
      expectedUpdatedAt: 1000,
    })
  );
});

test('assignment refuses users outside the workspace before any write', async t => {
  const f = fixture();
  await t.throwsAsync(() =>
    f.service.create('member', 'workspace', {
      title: 'Task',
      assigneeId: 'outsider',
    })
  );
  t.false(f.calls.includes('create'));
});

test('stale revisions cannot overwrite newer task edits', async t => {
  const f = fixture();
  await t.throwsAsync(() =>
    f.service.update('member', 'workspace', 'task', {
      title: 'stale',
      expectedUpdatedAt: 999,
    })
  );
  t.is(f.row.title, 'Public task');
  t.is(f.history.length, 1);
  const updated = await f.service.update('member', 'workspace', 'task', {
    title: 'fresh',
    expectedUpdatedAt: 1000,
  });
  t.is(updated.title, 'fresh');
  t.true(updated.updatedAt > 1000);
  await t.throwsAsync(() =>
    f.service.update('member', 'workspace', 'task', {
      title: 'old tab',
      expectedUpdatedAt: 1000,
    })
  );
});

test('archive and restore are explicit persisted field changes', async t => {
  const f = fixture();
  const archived = await f.service.update('member', 'workspace', 'task', {
    archived: true,
    expectedUpdatedAt: 1000,
  });
  t.true(archived.archived);
  const restored = await f.service.update('member', 'workspace', 'task', {
    archived: false,
    expectedUpdatedAt: archived.updatedAt,
  });
  t.false(restored.archived);
  t.is(restored.history.length, 3);
});

test('linking and source-filtered queries reject unreadable private documents', async t => {
  const f = fixture();
  await t.throwsAsync(() =>
    f.service.link('member', 'workspace', 'task', 'private-doc')
  );
  await t.throwsAsync(() =>
    f.service.list('member', 'workspace', undefined, undefined, 'private-doc')
  );
  t.is(f.history.length, 1);
});

test('permission revocation removes source from the next response and history remains generic', async t => {
  const f = fixture();
  t.is(
    (await f.service.get('member', 'workspace', 'task')).linkedDocIds.length,
    1
  );
  f.readable.clear();
  const result = await f.service.get('member', 'workspace', 'task');
  t.deepEqual(result.linkedDocIds, []);
  t.false(JSON.stringify(result).includes('public-doc'));
  t.false(JSON.stringify(result).includes('Readable source'));
});

test('forged legacy ACL fields, invalid dates and unbounded pagination are rejected', async t => {
  const f = fixture();
  await t.throwsAsync(() =>
    f.service.create('member', 'workspace', {
      title: 'Task',
      legacyDocId: 'private-doc',
    })
  );
  await t.throwsAsync(() =>
    f.service.create('member', 'workspace', {
      title: 'Task',
      dueDate: '2026-02-31',
    })
  );
  await t.throwsAsync(() => f.service.list('member', 'workspace', '-1'));
  await t.throwsAsync(() =>
    f.service.list('member', 'workspace', undefined, '10000')
  );
});

test('session mutations require a matching CSRF token before service execution', async t => {
  let called = false;
  const controller = new WorkspaceTasksController({
    create: async () => {
      called = true;
    },
  } as unknown as WorkspaceTasksService);
  const user = { id: 'member' } as CurrentUser;
  const request = {
    authType: 'session',
    get: () => undefined,
    cookies: { affine_csrf_token: 'cookie' },
  } as unknown as Request;
  t.throws(
    () => controller.create(user, 'workspace', request, { title: 'Task' }),
    { instanceOf: ActionForbidden }
  );
  t.false(called);
});

test('context picker and attach exclude trashed documents without scanning their snapshots', async t => {
  const f = fixture();
  (f.pages.get(0) as Map<unknown>).set('trash', true);
  const result = await f.service.context('member', 'workspace');
  t.deepEqual(result.docs, []);
  await t.throwsAsync(() =>
    f.service.link('member', 'workspace', 'task', 'public-doc')
  );
  t.is(f.history.length, 1);
});

test('deleted legacy ACL anchors fail closed despite permissive document defaults', async t => {
  const f = fixture();
  f.row.legacyDocId = 'public-doc';
  f.snapshotIds.delete('public-doc');
  t.deepEqual((await f.service.list('member', 'workspace')).tasks, []);
  await t.throwsAsync(() => f.service.get('member', 'workspace', 'task'));
  await t.throwsAsync(() =>
    f.service.update('member', 'workspace', 'task', {
      title: 'changed',
      expectedUpdatedAt: 1000,
    })
  );
  await t.throwsAsync(() =>
    f.service.link('member', 'workspace', 'task', 'public-doc')
  );
  t.is(f.row.title, 'Public task');
  t.is(f.history.length, 1);
});

test('legacy anchors still exist while their latest state has pending updates only', async t => {
  const f = fixture();
  f.row.legacyDocId = 'public-doc';
  f.snapshotIds.delete('public-doc');
  f.pendingIds.add('public-doc');
  t.is((await f.service.list('member', 'workspace')).tasks.length, 1);
  t.is((await f.service.get('member', 'workspace', 'task')).id, 'task');
});

test('attaching an existing link is idempotent without revision or history churn', async t => {
  const f = fixture();
  const result = await f.service.link(
    'member',
    'workspace',
    'task',
    'public-doc'
  );
  t.is(result.updatedAt, 1000);
  t.is(f.row.version, 1);
  t.is(f.history.length, 1);
});

test('AFFiNE HTTP mapping preserves task denial, validation, missing and conflict statuses', async t => {
  const f = fixture();
  const cases: Array<[() => Promise<unknown>, number]> = [
    [() => f.service.list('guest', 'workspace'), 403],
    [() => f.service.create('member', 'workspace', { title: '' }), 400],
    [() => f.service.get('member', 'workspace', 'missing'), 404],
    [
      () =>
        f.service.update('member', 'workspace', 'task', {
          title: 'stale',
          expectedUpdatedAt: 999,
        }),
      409,
    ],
  ];
  for (const [run, status] of cases) {
    const error = await t.throwsAsync(run);
    t.is(mapAnyError(error).status, status);
    t.is(mapAnyError(error).toJSON().status, status);
  }
});

test('AFFiNE HTTP mapping keeps failed CSRF a 403 rather than a server error', t => {
  const f = fixture();
  const controller = new WorkspaceTasksController(f.service);
  const req = {
    authType: 'session',
    get: () => undefined,
    cookies: {},
  } as unknown as Request;
  const error = t.throws(() =>
    controller.create({ id: 'member' } as CurrentUser, 'workspace', req, {
      title: 'Task',
    })
  );
  t.is(mapAnyError(error).status, 403);
});
