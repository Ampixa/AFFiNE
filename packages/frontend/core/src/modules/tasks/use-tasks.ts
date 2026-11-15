import { UserFriendlyError } from '@affine/error';
import { useLiveData, useServices } from '@toeverything/infra';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Subscription } from 'rxjs';
import { Text as YText } from 'yjs';

import { AuthService, WorkspaceServerService } from '../cloud';
import { type Doc, DocsService } from '../doc';
import { GuardService, WorkspacePermissionService } from '../permissions';
import { NbstoreService } from '../storage';
import { WorkspaceService } from '../workspace';
import { removeLegacyLinkReferences } from './legacy-links';
import {
  type CreateTaskInput,
  readTask,
  SOURCE_TASKS_MAP,
  type Task,
  TASK_HISTORY_MAP,
  TASK_LINKS_MAP,
  TASK_MAP,
  type TaskPatch,
  validateTaskPatch,
} from './model';

type OpenDoc = {
  doc: Doc;
  release: () => void;
  stop: () => void;
  canEdit: boolean;
};

/** Task data lives in each protected document, never workspace-wide metadata. */
export function useTasks() {
  const {
    docsService,
    guardService,
    workspaceService,
    workspaceServerService,
    nbstoreService,
    workspacePermissionService,
  } = useServices({
    DocsService,
    GuardService,
    WorkspaceService,
    WorkspaceServerService,
    NbstoreService,
    WorkspacePermissionService,
  });
  const ids = useLiveData(docsService.list.nonTrashDocsIds$);
  const idsKey = ids.join('\n');
  const workspace = workspaceService.workspace;
  const isLocal =
    workspace.flavour === 'local' && !workspace.openOptions.isSharedMode;
  const auth = workspaceServerService.server?.scope.get(AuthService);
  const currentUserId = useLiveData(auth?.session.account$)?.id ?? null;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [readableDocs, setReadableDocs] = useState<
    { id: string; title: string; canEdit: boolean }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const held = useRef(new Map<string, OpenDoc>());
  const readableIds = useRef(new Set<string>());
  const mounted = useRef(false);
  const generation = useRef(0);
  const scanning = useRef<Promise<void> | null>(null);
  const publish = useCallback(() => {
    if (!mounted.current) return;
    const result: Task[] = [];
    const sourcesByTask = new Map<string, string[]>();
    const taskByToken = new Map<string, string>();
    held.current.forEach(({ doc }, taskId) => {
      if (!readableIds.current.has(taskId) || doc.trash$.value) return;
      const fields = doc.yDoc.getMap(TASK_MAP);
      const token = fields.get('linkToken');
      if (fields.get('schemaVersion') === 1 && typeof token === 'string')
        taskByToken.set(token, taskId);
    });
    held.current.forEach(({ doc }, sourceId) => {
      if (!readableIds.current.has(sourceId) || doc.trash$.value) return;
      doc.yDoc.getMap(SOURCE_TASKS_MAP).forEach((linked, token) => {
        const taskId = taskByToken.get(token);
        if (linked !== true || !taskId) return;
        const sources = sourcesByTask.get(taskId) ?? [];
        sources.push(sourceId);
        sourcesByTask.set(taskId, sources);
      });
    });
    held.current.forEach(({ doc, canEdit }, id) => {
      if (!readableIds.current.has(id) || doc.trash$.value) return;
      const task = readTask(
        id,
        doc.title$.value,
        doc.yDoc.getMap(TASK_MAP),
        doc.yDoc.getMap(TASK_LINKS_MAP),
        doc.yDoc.getMap(TASK_HISTORY_MAP),
        canEdit
      );
      if (task)
        result.push({
          ...task,
          linkedDocIds: (sourcesByTask.get(id) ?? []).sort(),
        });
    });
    setTasks(result.sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);
  const allowed = useCallback(
    async (
      action: 'Doc_Read' | 'Doc_Update' | 'Doc_Users_Read',
      id: string
    ) => {
      if (workspace.openOptions.isSharedMode) return false;
      if (isLocal) return true;
      try {
        return await guardService.can(action, id);
      } catch (failure) {
        if (UserFriendlyError.fromAny(failure).is('DOC_ACTION_DENIED'))
          return false;
        // Server diagnostic messages can contain inaccessible document IDs.
        throw new Error('Could not verify document access. Please retry.');
      }
    },
    [guardService, isLocal, workspace]
  );
  const drop = useCallback((id: string) => {
    const entry = held.current.get(id);
    if (entry) {
      entry.stop();
      entry.release();
      held.current.delete(id);
    }
  }, []);
  const refresh = useCallback(async () => {
    // Ordinary refreshes must not restart a slow scan. Access events explicitly
    // clear this promise and invalidate its generation before rechecking.
    if (scanning.current) return scanning.current;
    const token = ++generation.current;
    const active = () => mounted.current && generation.current === token;
    const run = (async () => {
      try {
        if (!isLocal)
          await workspacePermissionService.permission.waitForRevalidation();
        if (!active()) return;
        const create =
          !workspace.openOptions.isSharedMode &&
          (isLocal || (await guardService.can('Workspace_CreateDoc')));
        const visible: { id: string; title: string; canEdit: boolean }[] = [];
        const readable = new Set<string>();
        let incomplete = false;
        const scanDoc = async (id: string) => {
          if (!active()) return;
          const canRead = await allowed('Doc_Read', id);
          if (!active()) return;
          if (!canRead) {
            drop(id);
            return;
          }
          const record = docsService.list.doc$(id).value;
          if (!record || record.trash$.value) {
            drop(id);
            return;
          }
          const canEditSource = await allowed('Doc_Update', id);
          if (!active()) return;
          readable.add(id);
          visible.push({
            id,
            title: record.title$.value || 'Untitled',
            canEdit: canEditSource,
          });
          let entry = held.current.get(id);
          if (!entry) {
            const opened = docsService.open(id);
            try {
              // A newly granted document may be absent from incremental remote
              // clocks, or have a cached permission error. Re-request only this
              // authorized document once when opening it, never on each scan.
              let loadTimer: ReturnType<typeof setTimeout> | undefined;
              let loaded: boolean;
              try {
                loaded = await Promise.race([
                  (async () => {
                    if (!isLocal) await workspace.engine.doc.retryDoc(id);
                    await opened.doc.waitForSyncReady();
                    return true;
                  })(),
                  new Promise<false>(resolve => {
                    loadTimer = setTimeout(() => resolve(false), 5000);
                  }),
                ]);
              } finally {
                clearTimeout(loadTimer);
              }
              if (!loaded) {
                opened.release();
                readable.delete(id);
                const index = visible.findIndex(item => item.id === id);
                if (index >= 0) visible.splice(index, 1);
                incomplete = true;
                return;
              }
              if (!active() || !(await allowed('Doc_Read', id))) {
                opened.release();
                readable.delete(id);
                const index = visible.findIndex(item => item.id === id);
                if (index >= 0) visible.splice(index, 1);
                return;
              }
              // Load-ready may precede remote hydration. Keep authorized docs
              // observed so later task fields or source relations become visible.
              // Dropping currently empty maps would miss those incoming updates.
              const canEdit = await allowed('Doc_Update', id);
              if (!active()) {
                opened.release();
                return;
              }
              entry = { ...opened, canEdit, stop: () => {} };
              const emit = () => publish();
              opened.doc.yDoc.on('afterTransaction', emit);
              const titleSubscription = opened.doc.title$.subscribe(emit);
              entry.stop = () => {
                opened.doc.yDoc.off('afterTransaction', emit);
                titleSubscription.unsubscribe();
              };
              held.current.set(id, entry);
            } catch (e) {
              opened.release();
              throw e;
            }
          } else {
            const canEdit = await allowed('Doc_Update', id);
            if (!active()) return;
            entry.canEdit = canEdit;
          }
        };
        const pendingIds = [...docsService.list.nonTrashDocsIds$.value];
        let next = 0;
        // Bound network and document-loading work without serializing the whole
        // workspace behind one round trip per permission check.
        await Promise.all(
          Array.from({ length: Math.min(4, pendingIds.length) }, async () => {
            while (active() && next < pendingIds.length) {
              await scanDoc(pendingIds[next++]);
            }
          })
        );
        if (!active()) return;
        for (const id of held.current.keys()) if (!readable.has(id)) drop(id);
        readableIds.current = readable;
        setReadableDocs(visible);
        setCanCreate(create);
        setError(
          incomplete
            ? 'Some documents are still syncing. Task results may be incomplete; refresh to retry.'
            : null
        );
        publish();
      } catch {
        if (active()) {
          generation.current++;
          setLoading(false);
          setError(
            'Could not verify task access. Please refresh and try again.'
          );
          setTasks([]);
          setReadableDocs([]);
          setCanCreate(false);
          readableIds.current.clear();
          for (const id of held.current.keys()) drop(id);
        }
      } finally {
        if (active()) setLoading(false);
      }
    })();
    scanning.current = run;
    try {
      await run;
    } finally {
      if (scanning.current === run) scanning.current = null;
    }
  }, [
    allowed,
    docsService,
    drop,
    guardService,
    isLocal,
    publish,
    workspace,
    workspacePermissionService,
  ]);
  const reportRefreshError = useCallback(() => {
    if (mounted.current) setError('Could not refresh tasks. Please try again.');
  }, []);
  useEffect(() => {
    const openedDocs = held.current;
    mounted.current = true;
    void refresh().catch(reportRefreshError);
    const timer = setInterval(
      () => void refresh().catch(reportRefreshError),
      30000
    );
    const onFocus = () => void refresh().catch(reportRefreshError);
    window.addEventListener('focus', onFocus);
    let accessReady = false;
    const accessSubscription = isLocal
      ? null
      : nbstoreService.realtime
          .subscribe('workspace.access.changed', { workspaceId: workspace.id })
          .subscribe({
            next: event => {
              if ('type' in event && event.type === 'ready' && !accessReady) {
                accessReady = true;
                return;
              }
              generation.current++;
              scanning.current = null;
              for (const id of held.current.keys()) drop(id);
              setCanCreate(false);
              setTasks([]);
              setReadableDocs([]);
              readableIds.current.clear();
              void refresh().catch(reportRefreshError);
            },
            error: () => {
              setError('Access updates disconnected. Refresh before editing.');
            },
          });
    return () => {
      mounted.current = false;
      // Invalidate the latest asynchronous scan, not the generation at effect setup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      scanning.current = null;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      accessSubscription?.unsubscribe();
      for (const id of openedDocs.keys()) drop(id);
    };
  }, [
    currentUserId,
    drop,
    idsKey,
    isLocal,
    nbstoreService,
    refresh,
    reportRefreshError,
    workspace.id,
  ]);

  const readableKey = readableDocs
    .map(doc => doc.id)
    .sort()
    .join('\n');
  useEffect(() => {
    if (isLocal || !readableKey) return;
    let cancelled = false;
    const subscriptions = new Subscription();
    const invalidate = (retry: boolean) => {
      if (cancelled) return;
      generation.current++;
      scanning.current = null;
      readableIds.current.clear();
      for (const id of held.current.keys()) drop(id);
      setTasks([]);
      setReadableDocs([]);
      setCanCreate(false);
      if (retry) void refresh().catch(reportRefreshError);
      else
        setError(
          'Document access updates disconnected. Refresh to verify access again.'
        );
    };
    for (const docId of readableKey.split('\n')) {
      let shareReady = false;
      subscriptions.add(
        nbstoreService.realtime
          .subscribe('doc.share-state.changed', {
            workspaceId: workspace.id,
            docId,
          })
          .subscribe({
            next: event => {
              if ('type' in event && event.type === 'ready' && !shareReady) {
                shareReady = true;
                return;
              }
              invalidate(true);
            },
            error: () => invalidate(false),
          })
      );
      void allowed('Doc_Users_Read', docId)
        .then(can => {
          if (cancelled || !can) return;
          let grantsReady = false;
          subscriptions.add(
            nbstoreService.realtime
              .subscribe('doc.grants.changed', {
                workspaceId: workspace.id,
                docId,
              })
              .subscribe({
                next: event => {
                  if (
                    'type' in event &&
                    event.type === 'ready' &&
                    !grantsReady
                  ) {
                    grantsReady = true;
                    return;
                  }
                  invalidate(true);
                },
                error: () => invalidate(false),
              })
          );
        })
        .catch(() => invalidate(false));
    }
    return () => {
      cancelled = true;
      subscriptions.unsubscribe();
    };
  }, [
    allowed,
    drop,
    isLocal,
    nbstoreService,
    readableKey,
    refresh,
    reportRefreshError,
    workspace.id,
  ]);

  const verifyAssignee = useCallback(
    async (id: string | null | undefined) => {
      if (!id) return;
      if (isLocal) {
        if (id !== currentUserId)
          throw new Error(
            'Local workspaces do not have a team directory. Leave the task unassigned.'
          );
        return;
      }
      let skip = 0;
      while (true) {
        const result = await nbstoreService.realtime.request(
          'workspace.members.get',
          { workspaceId: workspace.id, skip, take: 100 },
          { timeoutMs: 10000 }
        );
        if (
          result.members.some(
            member => member.id === id && member.status === 'Accepted'
          )
        )
          return;
        if (result.members.length < 100) break;
        skip += 100;
      }
      throw new Error('This assignee is no longer a workspace member.');
    },
    [currentUserId, isLocal, nbstoreService, workspace.id]
  );
  const withWritable = useCallback(
    async (id: string, action: (doc: Doc) => Promise<void> | void) => {
      if (!isLocal)
        await workspacePermissionService.permission.waitForRevalidation();
      if (
        !(await allowed('Doc_Read', id)) ||
        !(await allowed('Doc_Update', id))
      )
        throw new Error('You no longer have permission to edit this task.');
      const opened = docsService.open(id);
      try {
        await opened.doc.waitForSyncReady();
        if (!(await allowed('Doc_Update', id)))
          throw new Error('Task editing access changed.');
        await action(opened.doc);
      } finally {
        opened.release();
      }
      await refresh();
    },
    [allowed, docsService, isLocal, refresh, workspacePermissionService]
  );
  const audit = useCallback(
    (doc: Doc, body: string) =>
      doc.yDoc.getMap(TASK_HISTORY_MAP).set(crypto.randomUUID(), {
        actorId: currentUserId,
        at: Date.now(),
        body,
      }),
    [currentUserId]
  );
  const linkDocument = useCallback(
    async (taskId: string, sourceId: string) => {
      if (taskId === sourceId) throw new Error('A task cannot link to itself.');
      if (
        !(await allowed('Doc_Read', taskId)) ||
        !(await allowed('Doc_Update', taskId))
      )
        throw new Error('You no longer have permission to link this task.');
      // The source owns the relation. Never copy its identifier, title, or a
      // native reference into a task that may have a broader readership.
      await withWritable(sourceId, async source => {
        const opened = docsService.open(taskId);
        try {
          await opened.doc.waitForSyncReady();
          if (
            !(await allowed('Doc_Read', taskId)) ||
            !(await allowed('Doc_Update', taskId))
          )
            throw new Error('Task access changed while linking.');
          if (opened.doc.yDoc.getMap(TASK_MAP).get('schemaVersion') !== 1)
            throw new Error('This document is not a task.');
          if (opened.doc.yDoc.getMap(TASK_LINKS_MAP).size > 0)
            throw new Error(
              'This task has legacy links. Remove those links and their document references before linking again.'
            );
          if (!(await allowed('Doc_Update', sourceId)))
            throw new Error(
              'You need edit access to the context document to link it.'
            );
          const fields = opened.doc.yDoc.getMap(TASK_MAP);
          let token = fields.get('linkToken');
          if (typeof token !== 'string' || !token) {
            token = crypto.randomUUID();
            fields.set('linkToken', token);
          }
          // The token cannot identify a task without access to its document.
          // Neither endpoint stores the other document's ID or title.
          source.yDoc.getMap(SOURCE_TASKS_MAP).set(token as string, true);
        } finally {
          opened.release();
        }
      });
    },
    [allowed, docsService, withWritable]
  );
  const updateTask = useCallback(
    async (id: string, patch: TaskPatch, expectedUpdatedAt?: number) => {
      let result: Task | null = null;
      await verifyAssignee(patch.assigneeId);
      await withWritable(id, doc => {
        const fields = doc.yDoc.getMap(TASK_MAP);
        const current = readTask(
          id,
          doc.title$.value,
          fields,
          doc.yDoc.getMap(TASK_LINKS_MAP),
          doc.yDoc.getMap(TASK_HISTORY_MAP),
          true
        );
        if (!current) throw new Error('This document is not a task.');
        if (
          expectedUpdatedAt !== undefined &&
          current.updatedAt !== expectedUpdatedAt
        )
          throw new Error(
            'This task changed while you were editing. Reopen it to review the latest version.'
          );
        const clean = validateTaskPatch(patch, current);
        const changed = Object.entries(clean).filter(
          ([key, value]) => current[key as keyof Task] !== value
        );
        if (!changed.length) {
          result = current;
          return;
        }
        doc.yDoc.transact(() => {
          for (const [key, value] of changed) {
            if (key === 'title') doc.changeDocTitle(String(value));
            else fields.set(key, value);
          }
          fields.set('updatedAt', Math.max(Date.now(), current.updatedAt + 1));
          audit(
            doc,
            'Updated ' +
              changed
                .map(([key]) => (key === 'assigneeId' ? 'owner' : key))
                .join(', ') +
              '.'
          );
        });
        result = readTask(
          id,
          doc.title$.value,
          fields,
          doc.yDoc.getMap(TASK_LINKS_MAP),
          doc.yDoc.getMap(TASK_HISTORY_MAP),
          true
        );
      });
      if (!result) throw new Error('Could not read the updated task.');
      return result as Task;
    },
    [audit, verifyAssignee, withWritable]
  );
  const removeLegacyLinks = useCallback(
    async (id: string) => {
      let result: Task | null = null;
      await withWritable(id, doc => {
        const fields = doc.yDoc.getMap(TASK_MAP);
        const links = doc.yDoc.getMap(TASK_LINKS_MAP);
        const history = doc.yDoc.getMap(TASK_HISTORY_MAP);
        const current = readTask(
          id,
          doc.title$.value,
          fields,
          links,
          history,
          true
        );
        if (!current) throw new Error('This document is not a task.');
        if (links.size === 0) {
          result = current;
          return;
        }
        const legacyIds = new Set(links.keys());
        const texts: YText[] = [];
        for (const model of doc.blockSuiteDoc.getAllModels()) {
          const value = (model.props as Record<string, unknown>).text;
          if (
            value &&
            typeof value === 'object' &&
            'yText' in value &&
            value.yText instanceof YText
          )
            texts.push(value.yText);
        }
        doc.yDoc.transact(() => {
          removeLegacyLinkReferences(texts, legacyIds);
          links.clear();
          fields.set('updatedAt', Math.max(Date.now(), current.updatedAt + 1));
          audit(
            doc,
            'Removed current legacy link metadata and matching references. Earlier history and backups are unchanged.'
          );
        });
        result = readTask(id, doc.title$.value, fields, links, history, true);
      });
      if (!result) throw new Error('Could not read the cleaned task.');
      return result as Task;
    },
    [audit, withWritable]
  );
  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      if (!isLocal)
        await workspacePermissionService.permission.waitForRevalidation();
      if (
        workspace.openOptions.isSharedMode ||
        (!isLocal && !(await guardService.can('Workspace_CreateDoc')))
      )
        throw new Error('You cannot create documents in this workspace.');
      const { linkedDocIds = [], ...patch } = input;
      const clean = validateTaskPatch(patch);
      await verifyAssignee(clean.assigneeId);
      for (const id of linkedDocIds)
        if (!(await allowed('Doc_Read', id)))
          throw new Error('A related document is no longer accessible.');
      const record = docsService.createDoc({ title: clean.title });
      const opened = docsService.open(record.id);
      let createdTask: Task | null = null;
      try {
        const fields = opened.doc.yDoc.getMap(TASK_MAP);
        opened.doc.yDoc.transact(() => {
          fields.set('schemaVersion', 1);
          fields.set('linkToken', crypto.randomUUID());
          fields.set('status', 'inbox');
          fields.set('priority', 'normal');
          fields.set('archived', false);
          for (const [key, value] of Object.entries(clean))
            if (key !== 'title') fields.set(key, value);
          fields.set('updatedAt', Date.now());
          audit(opened.doc, 'Created task.');
        });
        createdTask = readTask(
          record.id,
          opened.doc.title$.value,
          fields,
          opened.doc.yDoc.getMap(TASK_LINKS_MAP),
          opened.doc.yDoc.getMap(TASK_HISTORY_MAP),
          true
        );
      } finally {
        opened.release();
      }
      try {
        for (const id of new Set(linkedDocIds))
          await linkDocument(record.id, id);
      } catch (e) {
        await refresh();
        throw Object.assign(
          new Error(
            `Task created, but linking did not finish. Open the task to retry. ${e instanceof Error ? e.message : ''}`
          ),
          { createdTaskId: record.id, createdTask }
        );
      }
      await refresh();
      return record.id;
    },
    [
      allowed,
      audit,
      docsService,
      guardService,
      isLocal,
      linkDocument,
      refresh,
      verifyAssignee,
      workspace,
      workspacePermissionService,
    ]
  );
  return {
    tasks,
    loading,
    error,
    readableDocs,
    canCreate,
    isLocal,
    currentUserId,
    refresh,
    createTask,
    updateTask,
    linkDocument,
    removeLegacyLinks,
  };
}
