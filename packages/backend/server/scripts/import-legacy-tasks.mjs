import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { applyUpdate, Array as YArray, Doc, Map as YMap } from 'yjs';

const statuses = new Set([
  'inbox',
  'ready',
  'doing',
  'blocked',
  'review',
  'done',
  'parked',
]);
const priorities = new Set(['low', 'normal', 'high', 'urgent']);

export class ImportValidationError extends Error {}

function validDate(value, fallback) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function eventId(workspaceId, docId, legacyId) {
  const hex = createHash('sha256')
    .update(JSON.stringify([workspaceId, docId, legacyId]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Reads persisted Yjs data only. Never opens an editor or writes a document. */
export function decodeLegacyDocument(
  workspaceId,
  id,
  snapshot,
  updates,
  title
) {
  const doc = new Doc({ guid: id });
  try {
    if (snapshot) applyUpdate(doc, snapshot.blob);
    for (const update of updates) applyUpdate(doc, update.blob);
    const fields = doc.getMap('ampixa:task');
    const sources = [...doc.getMap('ampixa:related-tasks')]
      .filter(([token, linked]) => typeof token === 'string' && linked === true)
      .map(([token]) => token);
    const pages = id === workspaceId ? doc.getMap('meta').get('pages') : null;
    const rootPages =
      pages instanceof YArray
        ? pages
            .toArray()
            .map(page => ({
              id: page instanceof YMap ? page.get('id') : undefined,
              title: page instanceof YMap ? page.get('title') : undefined,
              trash: page instanceof YMap ? Boolean(page.get('trash')) : true,
            }))
            .filter(page => typeof page.id === 'string')
        : null;
    if (fields.get('schemaVersion') !== 1)
      return { id, sources, task: null, rootPages };

    const nullable = key =>
      typeof fields.get(key) === 'string' ? fields.get(key) : null;
    const fallback =
      snapshot?.updatedAt ?? updates.at(-1)?.createdAt ?? new Date(0);
    let pageTitle = '';
    doc.getMap('blocks').forEach(block => {
      if (block instanceof YMap && block.get('sys:flavour') === 'affine:page') {
        pageTitle = block.get('prop:title')?.toString() ?? '';
      }
    });
    const history = [];
    doc.getMap('ampixa:task-history').forEach((event, key) => {
      if (
        !event ||
        typeof event !== 'object' ||
        typeof event.body !== 'string' ||
        typeof event.at !== 'number' ||
        !Number.isFinite(new Date(event.at).getTime())
      ) {
        throw new ImportValidationError(
          'A legacy task has malformed activity; review before importing.'
        );
      }
      history.push({
        id: eventId(workspaceId, id, key),
        actorId: typeof event.actorId === 'string' ? event.actorId : null,
        body: event.body,
        createdAt: new Date(event.at),
      });
    });
    return {
      id,
      sources,
      task: {
        workspaceId,
        legacyDocId: id,
        title: title || pageTitle || 'Untitled task',
        // Rich content remains in the original document, behind its original ACL.
        description: '',
        status: statuses.has(fields.get('status'))
          ? fields.get('status')
          : 'inbox',
        priority: priorities.has(fields.get('priority'))
          ? fields.get('priority')
          : 'normal',
        archived: fields.get('archived') === true,
        assigneeId: nullable('assigneeId'),
        dueDate: nullable('dueDate'),
        blockedReason: nullable('blockedReason') ?? '',
        createdAt: snapshot?.createdAt ?? updates[0]?.createdAt ?? fallback,
        updatedAt: validDate(fields.get('updatedAt'), fallback),
        createdBy: snapshot?.createdBy ?? updates[0]?.createdBy ?? null,
        updatedBy: snapshot?.updatedBy ?? updates.at(-1)?.createdBy ?? null,
        version: 1,
      },
      token: nullable('linkToken'),
      history,
      unsafeLegacyLinkCount: doc.getMap('ampixa:task-links').size,
    };
  } finally {
    doc.destroy();
  }
}

export function planLegacyImports(documents, existingLegacyIds) {
  const byToken = new Map();
  const legacyTasks = documents.filter(document => document.task);
  const root = documents.find(document => document.rootPages);
  if (legacyTasks.length && !root) {
    throw new ImportValidationError(
      'Root document metadata is missing; cannot distinguish trashed or orphaned tasks.'
    );
  }
  const metadata = new Map(
    (root?.rootPages ?? []).map(page => [page.id, page])
  );
  const tasks = legacyTasks.filter(
    task => metadata.has(task.id) && !metadata.get(task.id).trash
  );
  for (const task of tasks) {
    if (!task.token) continue;
    if (byToken.has(task.token)) {
      throw new ImportValidationError(
        'Duplicate legacy task link token; refusing ambiguous links.'
      );
    }
    byToken.set(task.token, task.id);
  }
  const links = new Map();
  for (const source of documents) {
    if (!metadata.has(source.id) || metadata.get(source.id).trash) continue;
    for (const token of source.sources) {
      const taskId = byToken.get(token);
      if (!taskId) continue;
      const ids = links.get(taskId) ?? new Set();
      ids.add(source.id);
      links.set(taskId, ids);
    }
  }
  return {
    candidates: tasks
      .filter(task => !existingLegacyIds.has(task.id))
      .map(task => ({
        ...task,
        task: {
          ...task.task,
          title: metadata.get(task.id).title || task.task.title,
        },
        linkedDocIds: [...(links.get(task.id) ?? [])],
      })),
    skipped: tasks.filter(task => existingLegacyIds.has(task.id)).length,
    trashedOrOrphanedTasksSkipped: legacyTasks.length - tasks.length,
    unsafeLegacyLinksRetained: legacyTasks.reduce(
      (sum, task) => sum + task.unsafeLegacyLinkCount,
      0
    ),
  };
}

/** Explicit, offline, workspace-scoped import. Re-runs never overwrite task edits. */
export async function importLegacyTasks(
  db,
  workspaceId,
  { apply = false } = {}
) {
  if (!workspaceId || workspaceId.length > 200) {
    throw new ImportValidationError('An explicit workspace ID is required.');
  }
  return db.$transaction(
    async tx => {
      // Concurrent importers serialize; the unique legacyDocId is a second guard.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`task-import:${workspaceId}`}))`;
      const workspace = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });
      if (!workspace)
        throw new ImportValidationError('Workspace does not exist.');
      const [snapshots, pending, titles, existing] = await Promise.all([
        tx.snapshot.findMany({ where: { workspaceId }, select: { id: true } }),
        tx.update.findMany({
          where: { workspaceId },
          distinct: ['id'],
          select: { id: true },
        }),
        tx.workspaceDoc.findMany({
          where: { workspaceId },
          select: { docId: true, title: true },
        }),
        tx.workspaceTask.findMany({
          where: { workspaceId, legacyDocId: { not: null } },
          select: { legacyDocId: true },
        }),
      ]);
      const titleById = new Map(titles.map(row => [row.docId, row.title]));
      const ids = new Set([...snapshots, ...pending].map(row => row.id));
      const documents = [];
      // Sequential bounded reads avoid loading the workspace's blobs at once.
      for (const id of ids) {
        const snapshot = await tx.snapshot.findUnique({
          where: { workspaceId_id: { workspaceId, id } },
        });
        const updates = await tx.update.findMany({
          where: { workspaceId, id },
          orderBy: { createdAt: 'asc' },
        });
        documents.push(
          decodeLegacyDocument(
            workspaceId,
            id,
            snapshot,
            updates,
            titleById.get(id)
          )
        );
      }
      const plan = planLegacyImports(
        documents,
        new Set(existing.map(task => task.legacyDocId))
      );
      if (apply) {
        for (const candidate of plan.candidates) {
          await tx.workspaceTask.create({
            data: {
              id: randomUUID(),
              ...candidate.task,
              links: {
                create: candidate.linkedDocIds.map(docId => ({ docId })),
              },
              activity: { create: candidate.history },
            },
          });
        }
      }
      return {
        mode: apply ? 'applied' : 'dry-run',
        documentsRead: documents.length,
        tasksToImport: plan.candidates.length,
        tasksImported: apply ? plan.candidates.length : 0,
        existingTasksSkipped: plan.skipped,
        trashedOrOrphanedTasksSkipped: plan.trashedOrOrphanedTasksSkipped,
        linksToImport: plan.candidates.reduce(
          (sum, task) => sum + task.linkedDocIds.length,
          0
        ),
        activityToImport: plan.candidates.reduce(
          (sum, task) => sum + task.history.length,
          0
        ),
        unsafeLegacyLinksRetainedInOriginalDocuments:
          plan.unsafeLegacyLinksRetained,
        documentWrites: 0,
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 300000 }
  );
}

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--workspace');
  const workspaceId = index >= 0 ? args[index + 1] : undefined;
  const apply = args.includes('--apply');
  const known = new Set([
    '--workspace',
    workspaceId,
    '--apply',
    '--confirm-offline',
  ]);
  if (
    !workspaceId ||
    args.some(arg => !known.has(arg)) ||
    (apply && !args.includes('--confirm-offline'))
  ) {
    throw new ImportValidationError(
      'Usage: node scripts/import-legacy-tasks.mjs --workspace ID [--apply --confirm-offline]. Apply only after backing up and stopping old application writers.'
    );
  }
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    console.log(
      JSON.stringify(await importLegacyTasks(db, workspaceId, { apply }))
    );
  } finally {
    await db.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(
      error instanceof ImportValidationError
        ? error.message
        : 'Import failed; transaction rolled back. Inspect locally without publishing credentials or document data.'
    );
    process.exitCode = 1;
  });
}
