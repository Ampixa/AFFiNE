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
  const members = new Set(['member', 'reader', 'editor', 'other']);
  const admins = new Set(['member']);
  const writers = new Set(['member', 'editor', 'other']);
  const comments: any[] = [];
  const readable = new Set(['public-doc']);
  const snapshotIds = new Set(['public-doc', 'private-doc']);
  const pendingIds = new Set<string>();
  const editable = new Set(['public-doc']);
  const calls: string[] = [];
  let onTransaction = () => {};
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
            (!where.assigneeId || r.assigneeId === where.assigneeId) &&
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
    taskComment: {
      findMany: async ({ where, skip = 0, take = 50 }: any) =>
        comments
          .filter(c => c.taskId === where.taskId)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id)
          )
          .slice(skip, skip + take),
      create: async ({ data }: any) => {
        const comment = {
          ...data,
          id: `comment-${comments.length}`,
          edited: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        comments.push(comment);
        return comment;
      },
      updateMany: async ({ where, data }: any) => {
        const comment = comments.find(
          c =>
            c.id === where.id &&
            c.taskId === where.taskId &&
            c.actorId === where.actorId &&
            c.updatedAt.getTime() === where.updatedAt.getTime()
        );
        if (!comment) return { count: 0 };
        Object.assign(comment, data);
        return { count: 1 };
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
    $queryRaw: async (
      _query: TemplateStringsArray,
      workspaceId: string,
      userId: string
    ) =>
      workspaceId === 'workspace' && members.has(userId)
        ? [{ id: 'membership' }]
        : [],
    $transaction: async (action: any) => {
      onTransaction();
      return action(db);
    },
  };
  const ac = {
    user: (userId: string) => ({
      workspace: () => ({
        assert: async (action: string) => {
          if (action === 'Workspace.CreateDoc' && !writers.has(userId))
            throw new ActionForbidden();
        },
        can: async (action: string) =>
          action === 'Workspace.Users.Manage'
            ? admins.has(userId)
            : writers.has(userId),
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
    members,
    admins,
    writers,
    comments,
    atTransaction: (fn: () => void) => {
      onTransaction = fn;
    },
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

test('ordinary members can read shared tasks but only owners can edit progress', async t => {
  const f = fixture();
  f.row.assigneeId = 'editor';
  const owner = await f.service.get('editor', 'workspace', 'task');
  t.true(owner.canEdit);
  t.false(owner.canAdmin);
  t.false((await f.service.list('editor', 'workspace')).canCreate);
  t.false((await f.service.get('other', 'workspace', 'task')).canEdit);
  const result = await f.service.update('editor', 'workspace', 'task', {
    description: 'Next step and linked resources',
    status: 'doing',
    expectedUpdatedAt: 1000,
  });
  t.is(result.status, 'doing');
  await t.throwsAsync(
    () =>
      f.service.update('other', 'workspace', 'task', {
        description: 'Tampered',
        expectedUpdatedAt: result.updatedAt,
      }),
    { instanceOf: ActionForbidden }
  );
  t.is(f.row.description, 'Next step and linked resources');
});

for (const patch of [
  { title: 'Changed' },
  { priority: 'urgent' },
  { dueDate: '2026-11-22' },
  { archived: true },
  { assigneeId: 'other' },
]) {
  test(`assigned members cannot change administrative field ${Object.keys(patch)[0]}`, async t => {
    const f = fixture();
    f.row.assigneeId = 'editor';
    await t.throwsAsync(
      () =>
        f.service.update('editor', 'workspace', 'task', {
          ...patch,
          expectedUpdatedAt: 1000,
        }),
      { instanceOf: ActionForbidden }
    );
    t.is(f.row.version, 1);
    t.is(f.history.length, 1);
  });
}

test('member cannot create a task or change its document links', async t => {
  const f = fixture();
  f.row.assigneeId = 'editor';
  await t.throwsAsync(
    () => f.service.create('editor', 'workspace', { title: 'Forged' }),
    { instanceOf: ActionForbidden }
  );
  await t.throwsAsync(
    () => f.service.link('editor', 'workspace', 'task', 'public-doc'),
    { instanceOf: ActionForbidden }
  );
  await t.throwsAsync(
    () => f.service.link('editor', 'workspace', 'task', 'public-doc', true),
    { instanceOf: ActionForbidden }
  );
  t.is(f.history.length, 1);
});

test('ownership changes invalidate an already opened member draft', async t => {
  const f = fixture();
  f.row.assigneeId = 'editor';
  const open = await f.service.get('editor', 'workspace', 'task');
  await f.service.update('member', 'workspace', 'task', {
    assigneeId: 'other',
    expectedUpdatedAt: open.updatedAt,
  });
  await t.throwsAsync(
    () =>
      f.service.update('editor', 'workspace', 'task', {
        status: 'done',
        expectedUpdatedAt: open.updatedAt,
      }),
    { instanceOf: ActionForbidden }
  );
  t.is(f.row.status, 'ready');
});

test('admin downgrade and membership removal reject subsequent writes', async t => {
  const f = fixture();
  const opened = await f.service.get('member', 'workspace', 'task');
  f.admins.delete('member');
  await t.throwsAsync(
    () =>
      f.service.update('member', 'workspace', 'task', {
        priority: 'urgent',
        expectedUpdatedAt: opened.updatedAt,
      }),
    { instanceOf: ActionForbidden }
  );
  f.members.delete('member');
  await t.throwsAsync(() => f.service.get('member', 'workspace', 'task'), {
    instanceOf: ActionForbidden,
  });
  await t.throwsAsync(
    () =>
      f.service.comment('member', 'workspace', 'task', { body: 'No access' }),
    { instanceOf: ActionForbidden }
  );
  t.is(f.comments.length, 0);
});

test('comments are shared among task readers and retain plain text without fetching links', async t => {
  const f = fixture();
  const body =
    '<img src=x onerror=alert(1)> https://example.com/report javascript:alert(1)';
  await f.service.comment('reader', 'workspace', 'task', { body });
  const own = await f.service.comments('reader', 'workspace', 'task');
  const other = await f.service.comments('editor', 'workspace', 'task');
  t.is(own[0].body, body);
  t.true(own[0].canEdit);
  t.false(other[0].canEdit);
  t.is(own[0].actorId, 'reader');
  t.is(f.history.at(-1)?.body, 'Added a comment.');
  t.false(JSON.stringify(f.history).includes(body));
});

test('only a comment author can edit it, including against workspace admins', async t => {
  const f = fixture();
  await f.service.comment('editor', 'workspace', 'task', { body: 'Original' });
  const comment = (await f.service.comments('editor', 'workspace', 'task'))[0];
  for (const actor of ['other', 'member']) {
    await t.throwsAsync(() =>
      f.service.comment(
        actor,
        'workspace',
        'task',
        {
          body: 'Impersonated',
          expectedUpdatedAt: comment.updatedAt,
        },
        comment.id
      )
    );
  }
  t.is(f.comments[0].body, 'Original');
  await f.service.comment(
    'editor',
    'workspace',
    'task',
    { body: 'Edited', expectedUpdatedAt: comment.updatedAt },
    comment.id
  );
  const edited = (await f.service.comments('editor', 'workspace', 'task'))[0];
  t.true(edited.edited);
  t.is(edited.body, 'Edited');
  t.true(edited.updatedAt > comment.updatedAt);
  await t.throwsAsync(() =>
    f.service.comment(
      'editor',
      'workspace',
      'task',
      {
        body: 'Stale overwrite',
        expectedUpdatedAt: comment.updatedAt,
      },
      comment.id
    )
  );
  t.is(f.comments[0].body, 'Edited');
});

test('comment validation rejects empty, oversized, forged author and missing revision', async t => {
  const f = fixture();
  for (const value of [
    { body: ' ' },
    { body: 'x'.repeat(10001) },
    { body: 'Hi', actorId: 'member' },
  ])
    await t.throwsAsync(() =>
      f.service.comment('editor', 'workspace', 'task', value)
    );
  await f.service.comment('editor', 'workspace', 'task', { body: 'Original' });
  await t.throwsAsync(() =>
    f.service.comment(
      'editor',
      'workspace',
      'task',
      { body: 'No revision' },
      f.comments[0].id
    )
  );
  t.is(f.comments.length, 1);
  t.is(f.comments[0].body, 'Original');
});

test('comment reads and writes deny guests, foreign workspace and private legacy tasks', async t => {
  const f = fixture();
  await f.service.comment('member', 'workspace', 'task', {
    body: 'Secret legacy discussion',
  });
  await t.throwsAsync(() => f.service.comments('guest', 'workspace', 'task'));
  await t.throwsAsync(() => f.service.comments('member', 'foreign', 'task'));
  f.row.legacyDocId = 'private-doc';
  await t.throwsAsync(() => f.service.comments('editor', 'workspace', 'task'));
  await t.throwsAsync(() =>
    f.service.comment('editor', 'workspace', 'task', { body: 'Hidden task' })
  );
  t.is(f.comments.length, 1);
});

test('comment identifiers are bound to the requested task and pagination is bounded', async t => {
  const f = fixture();
  await f.service.comment('editor', 'workspace', 'task', { body: 'First' });
  const original = f.comments[0];
  f.setRows([f.row, { ...f.row, id: 'other-task' }]);
  await t.throwsAsync(() =>
    f.service.comment(
      'editor',
      'workspace',
      'other-task',
      {
        body: 'Cross-task edit',
        expectedUpdatedAt: original.updatedAt.getTime(),
      },
      original.id
    )
  );
  for (let i = 0; i < 54; i++)
    await f.service.comment('editor', 'workspace', 'task', {
      body: `Comment ${i}`,
    });
  t.is((await f.service.comments('editor', 'workspace', 'task')).length, 50);
  t.is(
    (await f.service.comments('editor', 'workspace', 'task', '50')).length,
    5
  );
  await t.throwsAsync(() =>
    f.service.comments('editor', 'workspace', 'task', '-1')
  );
  t.is(original.body, 'First');
});

test('comment create and edit controllers enforce CSRF before service execution', t => {
  let called = false;
  const controller = new WorkspaceTasksController({
    comment: async () => {
      called = true;
    },
  } as unknown as WorkspaceTasksService);
  const req = {
    authType: 'session',
    get: () => undefined,
    cookies: {},
  } as unknown as Request;
  const user = { id: 'editor' } as CurrentUser;
  t.throws(
    () =>
      controller.comment(user, 'workspace', 'task', req, { body: 'Forged' }),
    { instanceOf: ActionForbidden }
  );
  t.throws(
    () =>
      controller.editComment(user, 'workspace', 'task', 'comment', req, {
        body: 'Forged',
      }),
    { instanceOf: ActionForbidden }
  );
  t.false(called);
});

for (const operation of ['create', 'update', 'comment', 'link'] as const) {
  test(`membership removed after initial access check blocks ${operation} before persistence`, async t => {
    const f = fixture();
    f.row.assigneeId = 'member';
    f.atTransaction(() => f.members.delete('member'));
    const actions = {
      create: () => f.service.create('member', 'workspace', { title: 'Race' }),
      update: () =>
        f.service.update('member', 'workspace', 'task', {
          description: 'Race',
          expectedUpdatedAt: 1000,
        }),
      comment: () =>
        f.service.comment('member', 'workspace', 'task', { body: 'Race' }),
      link: () => f.service.link('member', 'workspace', 'task', 'public-doc'),
    };
    await t.throwsAsync(actions[operation], { instanceOf: ActionForbidden });
    t.is(f.comments.length, 0);
    t.is(f.history.length, 1);
    t.is(f.row.version, 1);
    t.false(f.calls.includes('create'));
  });
}

test('admin downgraded between initial check and transaction cannot change protected fields', async t => {
  const f = fixture();
  f.row.assigneeId = 'member';
  f.atTransaction(() => f.admins.delete('member'));
  await t.throwsAsync(
    () =>
      f.service.update('member', 'workspace', 'task', {
        title: 'Race',
        expectedUpdatedAt: 1000,
      }),
    { instanceOf: ActionForbidden }
  );
  t.is(f.row.title, 'Public task');
  t.is(f.row.version, 1);
});

test('owner changed between permission check and atomic update cannot write', async t => {
  const f = fixture();
  f.row.assigneeId = 'editor';
  f.atTransaction(() => {
    f.row.assigneeId = 'other';
  });
  await t.throwsAsync(() =>
    f.service.update('editor', 'workspace', 'task', {
      description: 'Race',
      expectedUpdatedAt: 1000,
    })
  );
  t.is(f.row.description, '');
  t.is(f.row.version, 1);
});

test('Intelligence assigned-only guard prevents admin writing another owner task', async t => {
  const f = fixture();
  f.row.assigneeId = 'editor';
  await t.throwsAsync(
    () =>
      f.service.update(
        'member',
        'workspace',
        'task',
        { description: 'Admin via AI', expectedUpdatedAt: 1000 },
        true
      ),
    { instanceOf: ActionForbidden }
  );
  t.is(f.row.description, '');
});

test('legacy edit permission revoked before transaction is rechecked', async t => {
  const f = fixture();
  f.row.legacyDocId = 'public-doc';
  f.atTransaction(() => f.editable.delete('public-doc'));
  await t.throwsAsync(() =>
    f.service.update('member', 'workspace', 'task', {
      description: 'Race',
      expectedUpdatedAt: 1000,
    })
  );
  t.is(f.row.description, '');
  t.is(f.row.version, 1);
});

test('task detail returns newest conversation page and older pages remain accessible', async t => {
  const f = fixture();
  for (let i = 0; i < 55; i++)
    f.comments.push({
      id: `comment-${i}`,
      taskId: 'task',
      actorId: 'editor',
      body: `Update ${i}`,
      createdAt: new Date(i),
      updatedAt: new Date(i),
      edited: false,
    });
  const detail = await f.service.get('editor', 'workspace', 'task');
  t.is(detail.comments.length, 50);
  t.is(detail.comments[0].body, 'Update 54');
  const older = await f.service.comments('editor', 'workspace', 'task', '50');
  t.is(older.length, 5);
  t.is(older[0].body, 'Update 4');
});
