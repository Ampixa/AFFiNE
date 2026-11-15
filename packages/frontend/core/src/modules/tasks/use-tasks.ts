import { useLiveData, useServices } from '@toeverything/infra';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Subscription } from 'rxjs';

import { AuthService, WorkspaceServerService } from '../cloud';
import { GuardService } from '../permissions';
import { NbstoreService } from '../storage';
import { WorkspaceService } from '../workspace';
import {
  type CreateTaskInput,
  type Task,
  type TaskComment,
  type TaskPatch,
  validateTaskPatch,
} from './model';

type ContextDoc = { id: string; title: string; canEdit: boolean };
type TaskPage = {
  tasks: Task[];
  canCreate: boolean;
  linkedDocs: ContextDoc[];
  nextCursor: string | null;
};
type ContextPage = { docs: ContextDoc[]; nextCursor: string | null };

/** Team tasks are database rows. No document editor or document snapshot is opened. */
export function useTasks(options: { docId?: string } = {}) {
  const {
    workspaceService,
    workspaceServerService,
    nbstoreService,
    guardService,
  } = useServices({
    WorkspaceService,
    WorkspaceServerService,
    NbstoreService,
    GuardService,
  });
  const workspace = workspaceService.workspace;
  const server = workspaceServerService.server;
  const account = useLiveData(server?.scope.get(AuthService).session.account$);
  const isLocal = workspace.flavour === 'local';
  const available =
    !isLocal &&
    !workspace.openOptions.isSharedMode &&
    !!server &&
    !!account?.id;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [linkedDocs, setLinkedDocs] = useState<ContextDoc[]>([]);
  const [contextDocs, setContextDocs] = useState<ContextDoc[]>([]);
  const [contextCursor, setContextCursor] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState<string | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const contextRequest = useRef(0);
  const contextQuery = useRef('');
  const contextCursorRef = useRef<string | null>(null);
  const watches = useRef(new Map<string, Subscription>());
  const watchReady = useRef(new Map<string, Promise<boolean>>());
  const watchSettled = useRef(new Set<string>());
  const linkedWatchIds = useRef(new Set<string>());
  const contextWatchIds = useRef(new Set<string>());
  const invalidate = useRef<(retry: boolean) => void>(() => {});
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}/tasks`;

  const request = useCallback(
    async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      if (!available || !server)
        throw new Error('Team tasks require a signed-in workspace.');
      const csrf = document.cookie
        .split(';')
        .map(value => value.trim())
        .find(value => value.startsWith('affine_csrf_token='))
        ?.slice('affine_csrf_token='.length);
      const response = await server.fetch(base + path, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method !== 'GET' && csrf ? { 'x-affine-csrf-token': csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return response.status === 204
        ? (undefined as T)
        : (response.json() as Promise<T>);
    },
    [available, server, base]
  );

  const clearWatches = useCallback(() => {
    watches.current.forEach(subscription => subscription.unsubscribe());
    watches.current.clear();
    watchReady.current.clear();
    watchSettled.current.clear();
    linkedWatchIds.current.clear();
    contextWatchIds.current.clear();
  }, []);

  const watchDocument = useCallback(
    (id: string): Promise<boolean> => {
      const existing = watchReady.current.get(id);
      if (existing) {
        const pendingReady = !watchSettled.current.has(id);
        const subscription = watches.current.get(id);
        return existing.then(() => {
          if (
            !subscription ||
            subscription.closed ||
            watches.current.get(id) !== subscription
          )
            throw new Error(
              'Document access listener changed. Refresh to verify access.'
            );
          return pendingReady;
        });
      }
      const subscription = new Subscription();
      watches.current.set(id, subscription);
      const ready = (topic: 'doc.share-state.changed' | 'doc.grants.changed') =>
        new Promise<void>((resolve, reject) => {
          let initialized = false;
          const timer = setTimeout(
            () => reject(new Error('Document access updates are unavailable.')),
            10000
          );
          subscription.add(() => {
            clearTimeout(timer);
            resolve();
          });
          subscription.add(
            nbstoreService.realtime
              .subscribe(topic, { workspaceId: workspace.id, docId: id })
              .subscribe({
                next: event => {
                  if (
                    'type' in event &&
                    event.type === 'ready' &&
                    !initialized
                  ) {
                    initialized = true;
                    clearTimeout(timer);
                    resolve();
                  } else invalidate.current(true);
                },
                error: () => {
                  clearTimeout(timer);
                  reject(new Error('Document access updates are unavailable.'));
                  invalidate.current(false);
                },
              })
          );
        });
      const operation = (async () => {
        try {
          await ready('doc.share-state.changed');
          if (
            !subscription.closed &&
            (await guardService.can('Doc_Users_Read', id))
          )
            await ready('doc.grants.changed');
          if (subscription.closed || watches.current.get(id) !== subscription)
            throw new Error(
              'Document access listener changed. Refresh to verify access.'
            );
          watchSettled.current.add(id);
          return true;
        } catch (cause) {
          subscription.unsubscribe();
          if (watches.current.get(id) === subscription) {
            watches.current.delete(id);
            watchReady.current.delete(id);
            watchSettled.current.delete(id);
          }
          throw cause;
        }
      })();
      watchReady.current.set(id, operation);
      return operation;
    },
    [nbstoreService, workspace.id, guardService]
  );

  const assertWatched = useCallback((ids: ReadonlySet<string>) => {
    for (const id of ids) {
      const subscription = watches.current.get(id);
      if (!subscription || subscription.closed || !watchSettled.current.has(id))
        throw new Error(
          'Document access listener changed. Refresh to verify access.'
        );
    }
  }, []);

  const fetchPages = useCallback(async (): Promise<TaskPage> => {
    const all: TaskPage = {
      tasks: [],
      linkedDocs: [],
      canCreate: false,
      nextCursor: null,
    };
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      if (options.docId) query.set('docId', options.docId);
      const result = await request<TaskPage>('?' + query.toString());
      all.tasks.push(...result.tasks);
      all.linkedDocs.push(...result.linkedDocs);
      all.canCreate = result.canCreate;
      if (!result.nextCursor) return all;
      if (cursors.has(result.nextCursor))
        throw new Error(
          'Task pagination did not advance. Refresh to try again.'
        );
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error('This workspace has too many tasks to load in one view.');
  }, [options.docId, request]);

  const refresh = useCallback((): Promise<void> => {
    if (!available) return Promise.resolve();
    if (pending.current) return pending.current;
    const version = generation.current;
    const active = () => mounted.current && version === generation.current;
    const operation = (async () => {
      setLoading(true);
      try {
        let result = await fetchPages();
        if (!active()) return;
        // Only linked documents and legacy detail documents need access listeners.
        // Ordinary documents are never scanned to find tasks.
        let ids = new Set<string>();
        let stable = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          ids = new Set([
            ...result.linkedDocs.map(doc => doc.id),
            ...result.tasks.flatMap(task =>
              task.detailDocId ? [task.detailDocId] : []
            ),
          ]);
          let subscribed = false;
          for (const id of ids) {
            subscribed = (await watchDocument(id)) || subscribed;
            if (!active()) return;
          }
          if (!subscribed) {
            stable = true;
            break;
          }
          // Re-fetch until the returned set has no unwatched additions.
          result = await fetchPages();
          if (!active()) return;
        }
        if (!stable)
          throw new Error(
            'Task links are changing. Refresh to verify access again.'
          );
        linkedWatchIds.current = ids;
        for (const [id, subscription] of watches.current)
          if (!ids.has(id) && !contextWatchIds.current.has(id)) {
            subscription.unsubscribe();
            watches.current.delete(id);
            watchReady.current.delete(id);
            watchSettled.current.delete(id);
          }
        assertWatched(ids);
        setTasks(previous =>
          result.tasks.map(task => {
            const old = previous.find(value => value.id === task.id);
            return {
              ...task,
              comments: old?.comments ?? task.comments,
              commentsNextCursor: old?.commentsNextCursor,
              history:
                old?.updatedAt === task.updatedAt ? old.history : task.history,
            };
          })
        );
        setLinkedDocs([
          ...new Map(result.linkedDocs.map(doc => [doc.id, doc])).values(),
        ]);
        setCanCreate(result.canCreate);
        setError(null);
      } catch (cause) {
        if (active()) {
          setTasks([]);
          setLinkedDocs([]);
          setContextDocs([]);
          setCanCreate(false);
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not verify task access.'
          );
        }
        throw cause;
      } finally {
        if (active()) {
          pending.current = null;
          setLoading(false);
        }
      }
    })();
    pending.current = operation;
    return operation;
  }, [available, fetchPages, watchDocument, assertWatched]);

  useEffect(() => {
    mounted.current = true;
    const cancelPending = () => {
      generation.current++;
      contextRequest.current++;
      pending.current = null;
    };
    const clear = () => {
      cancelPending();
      clearWatches();
      setTasks([]);
      setLinkedDocs([]);
      setContextDocs([]);
      setContextCursor(null);
      contextCursorRef.current = null;
      setContextLoading(false);
      setCanCreate(false);
    };
    invalidate.current = retry => {
      clear();
      if (retry) void refresh().catch(() => {});
      else {
        setLoading(false);
        setError(
          'Access updates disconnected. Refresh to verify access again.'
        );
      }
    };
    if (!available) {
      clear();
      setLoading(false);
      return () => {
        mounted.current = false;
        clearWatches();
      };
    }
    let ready = false;
    const subscription = nbstoreService.realtime
      .subscribe('workspace.access.changed', { workspaceId: workspace.id })
      .subscribe({
        next: event => {
          if ('type' in event && event.type === 'ready' && !ready) {
            ready = true;
            void refresh().catch(() => {});
          } else invalidate.current(true);
        },
        error: () => invalidate.current(false),
      });
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh().catch(() => {});
    }, 30000);
    const focus = () => invalidate.current(true);
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      cancelPending();
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      subscription.unsubscribe();
      clearWatches();
      invalidate.current = () => {};
    };
  }, [
    available,
    clearWatches,
    nbstoreService,
    refresh,
    workspace.id,
    account?.id,
  ]);

  const searchDocuments = useCallback(
    async (query: string, more = false) => {
      if (!available) return;
      if (query.trim().length < 2) {
        contextRequest.current++;
        contextWatchIds.current.clear();
        contextCursorRef.current = null;
        for (const [id, subscription] of watches.current)
          if (!linkedWatchIds.current.has(id)) {
            subscription.unsubscribe();
            watches.current.delete(id);
            watchReady.current.delete(id);
            watchSettled.current.delete(id);
          }
        setContextDocs([]);
        setContextCursor(null);
        setContextLoading(false);
        return;
      }
      const version = ++contextRequest.current;
      const accessVersion = generation.current;
      const cursor = more ? contextCursorRef.current : null;
      contextQuery.current = query;
      setContextLoading(true);
      if (!more) {
        setContextDocs([]);
        setContextCursor(null);
      }
      try {
        const params = new URLSearchParams({ q: query, limit: '50' });
        if (cursor) params.set('cursor', cursor);
        let result = await request<ContextPage>(
          '/context-docs?' + params.toString()
        );
        if (
          !mounted.current ||
          version !== contextRequest.current ||
          accessVersion !== generation.current
        )
          return;
        let ids = new Set<string>();
        let stable = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          ids = new Set(
            more
              ? [...contextWatchIds.current, ...result.docs.map(doc => doc.id)]
              : result.docs.map(doc => doc.id)
          );
          contextWatchIds.current = ids;
          let subscribed = false;
          for (const id of ids) {
            subscribed = (await watchDocument(id)) || subscribed;
            if (
              !mounted.current ||
              version !== contextRequest.current ||
              accessVersion !== generation.current
            )
              return;
          }
          if (!subscribed) {
            stable = true;
            break;
          }
          result = await request<ContextPage>(
            '/context-docs?' + params.toString()
          );
          if (
            !mounted.current ||
            version !== contextRequest.current ||
            accessVersion !== generation.current
          )
            return;
        }
        if (!stable)
          throw new Error(
            'Document access is changing. Search again to verify it.'
          );
        contextWatchIds.current = ids;
        for (const [id, subscription] of watches.current)
          if (!ids.has(id) && !linkedWatchIds.current.has(id)) {
            subscription.unsubscribe();
            watches.current.delete(id);
            watchReady.current.delete(id);
            watchSettled.current.delete(id);
          }
        assertWatched(ids);
        setContextDocs(previous =>
          more ? [...previous, ...result.docs] : result.docs
        );
        contextCursorRef.current = result.nextCursor;
        setContextCursor(result.nextCursor);
      } catch (cause) {
        if (mounted.current && version === contextRequest.current) {
          setContextDocs([]);
          setContextCursor(null);
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not search documents.'
          );
        }
      } finally {
        if (mounted.current && version === contextRequest.current)
          setContextLoading(false);
      }
    },
    [available, request, watchDocument, assertWatched]
  );

  const loadTask = useCallback(
    async (id: string) => {
      const version = generation.current;
      const assertCurrent = () => {
        if (!mounted.current || version !== generation.current)
          throw new Error('Task access changed. Refresh before continuing.');
      };
      try {
        let task = await request<Task>('/' + encodeURIComponent(id));
        assertCurrent();
        for (let attempt = 0; attempt < 5; attempt++) {
          const ids = new Set([
            ...task.linkedDocIds,
            ...(task.detailDocId ? [task.detailDocId] : []),
          ]);
          let subscribed = false;
          for (const docId of ids) {
            subscribed = (await watchDocument(docId)) || subscribed;
            assertCurrent();
          }
          if (!subscribed) {
            ids.forEach(docId => linkedWatchIds.current.add(docId));
            assertWatched(ids);
            setTasks(previous =>
              previous.map(value =>
                value.id === id
                  ? {
                      ...task,
                      comments: [
                        ...new Map(
                          [
                            ...(value.comments ?? []),
                            ...(task.comments ?? []),
                          ].map(comment => [comment.id, comment])
                        ).values(),
                      ],
                      commentsNextCursor:
                        task.comments?.length === 50
                          ? Math.max(50, value.commentsNextCursor ?? 0)
                          : null,
                    }
                  : value
              )
            );
            return task;
          }
          task = await request<Task>('/' + encodeURIComponent(id));
          assertCurrent();
        }
        throw new Error(
          'Task links are changing. Reopen the task to verify access.'
        );
      } catch (cause) {
        if (mounted.current && version === generation.current)
          invalidate.current(true);
        throw cause;
      }
    },
    [request, watchDocument, assertWatched]
  );
  const updateTask = useCallback(
    async (id: string, patch: TaskPatch, expectedUpdatedAt?: number) => {
      const clean = validateTaskPatch(
        patch,
        tasks.find(task => task.id === id)
      );
      if (!Object.keys(clean).length) return loadTask(id);
      await request<Task>('/' + encodeURIComponent(id), 'PATCH', {
        ...clean,
        expectedUpdatedAt,
      });
      try {
        await refresh();
        return await loadTask(id);
      } catch {
        throw new Error(
          'Task saved, but current access could not be verified. Refresh before editing again.'
        );
      }
    },
    [request, refresh, tasks, loadTask]
  );
  const createTask = useCallback(
    async (input: CreateTaskInput) => {
      const task = await request<Task>('', 'POST', {
        ...validateTaskPatch(input),
        linkedDocIds: input.linkedDocIds ?? [],
      });
      await refresh().catch(() => {});
      return task.id;
    },
    [request, refresh]
  );
  const linkDocument = useCallback(
    async (id: string, docId: string) => {
      await request('/' + encodeURIComponent(id) + '/links', 'POST', { docId });
      try {
        await refresh();
      } catch {
        throw new Error(
          'Link change saved, but current access could not be verified. Refresh before continuing.'
        );
      }
    },
    [request, refresh]
  );
  const unlinkDocument = useCallback(
    async (id: string, docId: string) => {
      await request(
        '/' + encodeURIComponent(id) + '/links/' + encodeURIComponent(docId),
        'DELETE'
      );
      try {
        await refresh();
      } catch {
        throw new Error(
          'Link change saved, but current access could not be verified. Refresh before continuing.'
        );
      }
    },
    [request, refresh]
  );
  const loadMoreComments = useCallback(
    async (id: string, cursor: number) => {
      const version = generation.current;
      const comments = await request<TaskComment[]>(
        '/' + encodeURIComponent(id) + '/comments?cursor=' + cursor
      );
      if (!mounted.current || version !== generation.current)
        throw new Error(
          'Task access changed. Reopen the task before continuing.'
        );
      setTasks(previous =>
        previous.map(task =>
          task.id === id
            ? {
                ...task,
                comments: [
                  ...new Map(
                    [...(task.comments ?? []), ...comments].map(comment => [
                      comment.id,
                      comment,
                    ])
                  ).values(),
                ],
                commentsNextCursor:
                  comments.length === 50 ? cursor + comments.length : null,
              }
            : task
        )
      );
    },
    [request]
  );
  const comment = useCallback(
    async (id: string, body: string, existing?: TaskComment) => {
      await request(
        '/' +
          encodeURIComponent(id) +
          '/comments' +
          (existing ? '/' + encodeURIComponent(existing.id) : ''),
        existing ? 'PATCH' : 'POST',
        { body, ...(existing ? { expectedUpdatedAt: existing.updatedAt } : {}) }
      );
      try {
        await loadTask(id);
      } catch {
        throw new Error(
          'Comment saved but refresh failed. Reopen the task; do not submit again.'
        );
      }
    },
    [request, loadTask]
  );
  return {
    tasks,
    comment,
    loadMoreComments,
    loading,
    error,
    canCreate,
    isLocal,
    available,
    currentUserId: account?.id ?? null,
    readableDocs: [
      ...new Map(
        [...linkedDocs, ...contextDocs].map(doc => [doc.id, doc])
      ).values(),
    ],
    contextDocs,
    contextLoading,
    hasMoreContext: !!contextCursor,
    searchDocuments,
    loadMoreDocuments: () => searchDocuments(contextQuery.current, true),
    refresh,
    loadTask,
    createTask,
    updateTask,
    linkDocument,
    unlinkDocument,
  };
}
