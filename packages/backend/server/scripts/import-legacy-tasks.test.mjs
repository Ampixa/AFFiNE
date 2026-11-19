import assert from 'node:assert/strict';
import test from 'node:test';

import { Array as YArray, Doc, encodeStateAsUpdate, Map as YMap } from 'yjs';

import {
  decodeLegacyDocument,
  importLegacyTasks,
  planLegacyImports,
} from './import-legacy-tasks.mjs';

const workspaceId = 'workspace';
const date = new Date('2026-11-01T00:00:00Z');
function snapshot(id, doc) {
  return {
    id,
    workspaceId,
    blob: Buffer.from(encodeStateAsUpdate(doc)),
    createdAt: date,
    updatedAt: date,
    createdBy: 'author',
    updatedBy: 'author',
  };
}
function taskDoc(token = 'token') {
  const doc = new Doc();
  const task = doc.getMap('ampixa:task');
  task.set('schemaVersion', 1);
  task.set('linkToken', token);
  task.set('status', 'review');
  task.set('assigneeId', 'member');
  task.set('updatedAt', date.getTime());
  doc.getMap('ampixa:task-history').set('history-id', {
    actorId: 'author',
    at: date.getTime(),
    body: 'Created task.',
  });
  return doc;
}
function rootDoc(pages) {
  const doc = new Doc();
  doc.getMap('meta').set('pages', new YArray());
  doc
    .getMap('meta')
    .get('pages')
    .push(pages.map(page => new YMap(Object.entries(page))));
  return doc;
}
function decode(row) {
  return decodeLegacyDocument(workspaceId, row.id, row, [], 'Fallback title');
}
function fixtures() {
  const source = new Doc();
  source.getMap('ampixa:related-tasks').set('token', true);
  return [
    snapshot(
      workspaceId,
      rootDoc([
        { id: 'task', title: 'Existing task' },
        { id: 'source', title: 'Private source' },
      ])
    ),
    snapshot('task', taskDoc()),
    snapshot('source', source),
  ];
}
function fakeDb(rows) {
  const created = [];
  const db = {
    created,
    $executeRaw: async () => {},
    workspace: { findUnique: async () => ({ id: workspaceId }) },
    snapshot: {
      findMany: async () => rows.map(({ id }) => ({ id })),
      findUnique: async ({ where }) =>
        rows.find(row => row.id === where.workspaceId_id.id),
    },
    update: { findMany: async () => [] },
    workspaceDoc: { findMany: async () => [] },
    workspaceTask: {
      findMany: async () =>
        created.map(row => ({ legacyDocId: row.legacyDocId })),
      create: async ({ data }) => {
        created.push(data);
        return data;
      },
    },
    $transaction: async callback => callback(db),
  };
  return db;
}

test('merges pending Yjs updates without changing the stored snapshot', () => {
  const doc = taskDoc();
  const row = snapshot('task', doc);
  const before = Buffer.from(row.blob);
  doc.getMap('ampixa:task').set('archived', true);
  const result = decodeLegacyDocument(
    workspaceId,
    'task',
    row,
    [{ blob: encodeStateAsUpdate(doc), createdAt: date }],
    'Task'
  );
  assert.equal(result.task.archived, true);
  assert.deepEqual(row.blob, before);
  assert.equal(result.task.legacyDocId, 'task');
});

test('imports source-token links and preserves original permission anchor and history', () => {
  const plan = planLegacyImports(fixtures().map(decode), new Set());
  assert.equal(plan.candidates.length, 1);
  const task = plan.candidates[0];
  assert.equal(task.task.title, 'Existing task');
  assert.equal(task.task.legacyDocId, 'task');
  assert.equal(task.task.description, '');
  assert.equal(task.task.assigneeId, 'member');
  assert.equal(task.task.status, 'review');
  assert.deepEqual(task.linkedDocIds, ['source']);
  assert.equal(task.history[0].body, 'Created task.');
  assert.deepEqual(task.history[0].createdAt, date);
});

test('skips trashed/orphaned tasks and trashed sources instead of resurrecting them', () => {
  const rows = fixtures();
  rows[0] = snapshot(
    workspaceId,
    rootDoc([
      { id: 'task' },
      { id: 'source', trash: true },
      { id: 'trashed', trash: true },
    ])
  );
  rows.push(
    snapshot('trashed', taskDoc('trashed-token')),
    snapshot('orphan', taskDoc('orphan-token'))
  );
  const plan = planLegacyImports(rows.map(decode), new Set());
  assert.equal(plan.trashedOrOrphanedTasksSkipped, 2);
  assert.deepEqual(plan.candidates[0].linkedDocIds, []);
});

test('rejects duplicate task link tokens instead of joining the wrong task', () => {
  const rows = fixtures();
  rows[0] = snapshot(workspaceId, rootDoc([{ id: 'task' }, { id: 'other' }]));
  rows.push(snapshot('other', taskDoc()));
  assert.throws(
    () => planLegacyImports(rows.map(decode), new Set()),
    /Duplicate/
  );
});

test('missing root metadata fails closed for migration visibility', () => {
  assert.throws(
    () => planLegacyImports([decode(snapshot('task', taskDoc()))], new Set()),
    /Root document metadata/
  );
});

test('unsafe task-owned legacy references stay in original docs and are not imported', () => {
  const doc = taskDoc();
  doc.getMap('ampixa:task-links').set('secret-doc-id', true);
  const rows = fixtures();
  rows[1] = snapshot('task', doc);
  const plan = planLegacyImports(rows.map(decode), new Set());
  assert.equal(plan.unsafeLegacyLinksRetained, 1);
  assert.deepEqual(plan.candidates[0].linkedDocIds, ['source']);
  assert.equal(doc.getMap('ampixa:task-links').get('secret-doc-id'), true);
});

test('dry-run writes no tasks and apply is idempotent without overwriting new-table edits', async () => {
  const db = fakeDb(fixtures());
  const dryRun = await importLegacyTasks(db, workspaceId);
  assert.equal(dryRun.tasksToImport, 1);
  assert.equal(dryRun.tasksImported, 0);
  assert.equal(db.created.length, 0);
  const applied = await importLegacyTasks(db, workspaceId, { apply: true });
  assert.equal(applied.tasksImported, 1);
  assert.deepEqual(db.created[0].links.create, [{ docId: 'source' }]);
  assert.equal(db.created[0].activity.create.length, 1);
  db.created[0].title = 'User edited after migration';
  db.created[0].links.create = [];
  const again = await importLegacyTasks(db, workspaceId, { apply: true });
  assert.equal(again.existingTasksSkipped, 1);
  assert.equal(again.tasksImported, 0);
  assert.equal(db.created.length, 1);
  assert.equal(db.created[0].title, 'User edited after migration');
  assert.deepEqual(db.created[0].links.create, []);
});

test('malformed activity stops import before writes rather than losing history', async () => {
  const rows = fixtures();
  const doc = taskDoc();
  doc.getMap('ampixa:task-history').set('bad', { at: NaN, body: 'bad' });
  rows[1] = snapshot('task', doc);
  const db = fakeDb(rows);
  await assert.rejects(
    importLegacyTasks(db, workspaceId, { apply: true }),
    /malformed activity/
  );
  assert.equal(db.created.length, 0);
});
