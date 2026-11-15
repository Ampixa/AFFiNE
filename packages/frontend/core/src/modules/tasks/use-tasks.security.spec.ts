// @vitest-environment happy-dom
// Exercises the real React hook and Yjs records with mocked identity/permission
// services. This is not an authenticated server or multi-browser integration test.
import { UserFriendlyError } from '@affine/error';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { BehaviorSubject, startWith, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUpdate, Doc as YDoc, encodeStateAsUpdate } from 'yjs';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, any> }));
vi.mock('@toeverything/infra', async () => {
  const React = await import('react');
  return {
    useServices: () => fixture.services,
    useLiveData: (source: any) =>
      React.useSyncExternalStore(
        React.useCallback(
          (notify: () => void) => {
            const subscription = source?.subscribe(notify);
            return () => subscription?.unsubscribe();
          },
          [source]
        ),
        () => source?.value,
        () => source?.value
      ),
  };
});
vi.mock('../cloud', () => ({
  AuthService: class {},
  WorkspaceServerService: class {},
}));
vi.mock('../doc', () => ({ DocsService: class {} }));
vi.mock('../permissions', () => ({
  GuardService: class {},
  WorkspacePermissionService: class {},
}));
vi.mock('../storage', () => ({ NbstoreService: class {} }));
vi.mock('../workspace', () => ({ WorkspaceService: class {} }));

import {
  SOURCE_TASKS_MAP,
  TASK_HISTORY_MAP,
  TASK_LINKS_MAP,
  TASK_MAP,
} from './model';
import { useTasks } from './use-tasks';

function setup() {
  const records = new Map<string, any>();
  const docs = new Map<string, any>();
  const ids = new BehaviorSubject<string[]>([]);
  const permissions = new Map<string, boolean>();
  const events = new Map<string, Subject<unknown>>();
  const members: { id: string; status: string }[] = [];
  const storageUpdates = new Subject<{ docId: string; bin: Uint8Array }>();
  const event = (topic: string, docId = '') => {
    const key = topic + ':' + docId;
    if (!events.has(key)) events.set(key, new Subject());
    return events.get(key)!;
  };
  const addDoc = (id: string, title: string, task = false) => {
    const title$ = new BehaviorSubject(title);
    const trash$ = new BehaviorSubject(false);
    const record = { id, title$, trash$ };
    const yDoc = new YDoc();
    if (task) {
      yDoc.getMap(TASK_MAP).set('schemaVersion', 1);
      yDoc.getMap(TASK_MAP).set('updatedAt', 1);
    }
    const doc = {
      id,
      yDoc,
      title$,
      trash$,
      waitForSyncReady: vi.fn(async () => {}),
      changeDocTitle: (value: string) => title$.next(value),
      blockSuiteDoc: {
        getBlocksByFlavour: () => [{ id: 'note-' + id }],
        getAllModels: () => [
          { props: { text: { yText: yDoc.getText('body') } } },
        ],
      },
    };
    yDoc.on('update', (bin: Uint8Array) =>
      storageUpdates.next({ docId: id, bin })
    );
    records.set(id, record);
    docs.set(id, doc);
    ids.next([...records.keys()]);
    return doc;
  };
  const docsService = {
    list: {
      nonTrashDocsIds$: ids,
      doc$: (id: string) => new BehaviorSubject(records.get(id)),
    },
    open: vi.fn((id: string) => ({ doc: docs.get(id), release: vi.fn() })),
    addLinkedDoc: vi.fn(async (target: string, source: string) => {
      // Serializes the same LinkedPage identifier the native service writes.
      docs
        .get(target)
        .yDoc.getArray('reference-fixture')
        .push([{ reference: { type: 'LinkedPage', pageId: source } }]);
    }),
    createDoc: vi.fn(({ title }: { title: string }) => {
      const doc = addDoc('created-' + records.size, title);
      return records.get(doc.id);
    }),
  };
  fixture.services = {
    docsService,
    workspaceService: {
      workspace: {
        id: 'test-workspace',
        flavour: 'affine-cloud',
        openOptions: {},
        engine: {
          doc: {
            retryDoc: vi.fn(async () => {}),
            waitForSynced: vi.fn(async () => {}),
            storage: {
              pushDocUpdate: vi.fn(),
              subscribeDocUpdate: (
                callback: (update: { docId: string; bin: Uint8Array }) => void
              ) => {
                const subscription = storageUpdates.subscribe(callback);
                return () => subscription.unsubscribe();
              },
            },
          },
        },
      },
    },
    workspaceServerService: {
      server: {
        fetch: vi.fn(async (path: string) => {
          const id = decodeURIComponent(path.split('/').at(-2)!);
          const doc = docs.get(id);
          await doc.waitForSyncReady();
          const data = encodeStateAsUpdate(doc.yDoc);
          return {
            arrayBuffer: async () =>
              data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength
              ),
          };
        }),
        scope: {
          get: () => ({
            session: { account$: new BehaviorSubject({ id: 'user-a' }) },
          }),
        },
      },
    },
    guardService: {
      can: vi.fn(
        async (action: string, id = '') =>
          permissions.get(action + ':' + id) === true
      ),
    },
    nbstoreService: {
      realtime: {
        subscribe: (topic: string, input: { docId?: string }) =>
          event(topic, input.docId).pipe(startWith({ type: 'ready' })),
        request: vi.fn(async () => ({ members })),
      },
    },
    workspacePermissionService: {
      permission: { waitForRevalidation: vi.fn(async () => {}) },
    },
  };
  const grant = (id: string, write = false) => {
    permissions.set('Doc_Read:' + id, true);
    permissions.set('Doc_Update:' + id, write);
  };
  return {
    docs,
    docsService,
    permissions,
    events,
    event,
    members,
    addDoc,
    grant,
    fetch: fixture.services.workspaceServerService.server.fetch,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
beforeEach(() => {
  fixture.services = {};
});

describe('task security boundaries (mocked services, real hook and Yjs)', () => {
  it('leaves existing document bytes unchanged during discovery and refresh', async () => {
    const f = setup();
    const doc = f.addDoc('ordinary', 'Existing prose');
    doc.yDoc.getText('body').insert(0, 'Preserve this existing document.');
    f.grant(doc.id, true);
    const before = encodeStateAsUpdate(doc.yDoc);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.refresh();
    });
    expect(encodeStateAsUpdate(doc.yDoc)).toEqual(before);
    expect(f.docsService.open).not.toHaveBeenCalled();
    expect(
      fixture.services.workspaceService.workspace.engine.doc.retryDoc
    ).not.toHaveBeenCalled();
    expect(
      fixture.services.workspaceService.workspace.engine.doc.storage
        .pushDocUpdate
    ).not.toHaveBeenCalled();
  });

  it('enables permitted creation before the document scan finishes', async () => {
    const f = setup();
    f.permissions.set('Workspace_CreateDoc:', true);
    const doc = f.addDoc('slow', 'Slow context');
    let finish!: () => void;
    doc.waitForSyncReady.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    f.grant(doc.id);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.canCreate).toBe(true));
    expect(result.current.loading).toBe(true);
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scanProgress).toEqual({ completed: 1, total: 1 });
  });

  it('does not expose a snapshot if read access changes while it is downloading', async () => {
    const f = setup();
    const doc = f.addDoc('revoked-in-flight', 'Hidden task', true);
    let finish!: () => void;
    doc.waitForSyncReady.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    f.grant(doc.id);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      f.permissions.set('Doc_Read:' + doc.id, false);
      finish();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.readableDocs).toEqual([]);
    expect(f.docsService.open).not.toHaveBeenCalled();
  });

  it('sets up access listeners without a workspace-wide permission-query burst', async () => {
    const f = setup();
    for (let i = 0; i < 12; i++) {
      f.addDoc('doc-' + i, 'Task ' + i, true);
      f.grant('doc-' + i);
    }
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const can = fixture.services.guardService.can;
    can.mockImplementation(async (action: string, id = '') => {
      if (action === 'Doc_Users_Read') await gate;
      return f.permissions.get(action + ':' + id) === true;
    });
    const { result } = renderHook(() => useTasks());
    const grantsCalls = () =>
      can.mock.calls.filter(
        ([action]: [string]) => action === 'Doc_Users_Read'
      );
    await waitFor(() => expect(grantsCalls()).toHaveLength(1));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.loading).toBe(true);
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(grantsCalls()).toHaveLength(12));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('does not subscribe to unrelated context documents when there are no tasks', async () => {
    const f = setup();
    for (let i = 0; i < 12; i++) {
      f.addDoc('plain-' + i, 'Ordinary document');
      f.grant('plain-' + i);
    }
    const subscribe = vi.spyOn(
      fixture.services.nbstoreService.realtime,
      'subscribe'
    );
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(
      subscribe.mock.calls.filter(([topic]) => String(topic).startsWith('doc.'))
    ).toEqual([]);
    expect(
      fixture.services.guardService.can.mock.calls.filter(
        ([action]: [string]) => action === 'Doc_Users_Read'
      )
    ).toEqual([]);
  });

  it('withholds linked context until listeners are ready and rejects revocation during setup', async () => {
    const f = setup();
    const task = f.addDoc('task-with-context', 'Task', true);
    task.yDoc.getMap(TASK_MAP).set('linkToken', 'opaque-token');
    const source = f.addDoc('late-source', 'Private context');
    source.yDoc.getMap(SOURCE_TASKS_MAP).set('opaque-token', true);
    f.grant(task.id);
    f.grant(source.id);
    const realtime = fixture.services.nbstoreService.realtime;
    const original = realtime.subscribe;
    realtime.subscribe = vi.fn((topic: string, input: { docId?: string }) =>
      topic === 'doc.share-state.changed' && input.docId === source.id
        ? f.event(topic, source.id)
        : original(topic, input)
    );
    const { result } = renderHook(() => useTasks());
    await waitFor(() =>
      expect(
        realtime.subscribe.mock.calls.some(
          ([topic, input]: [string, { docId?: string }]) =>
            topic === 'doc.share-state.changed' && input.docId === source.id
        )
      ).toBe(true)
    );
    expect(result.current.tasks).toEqual([]);
    expect(result.current.readableDocs).toEqual([]);
    await act(async () => {
      f.permissions.set('Doc_Read:' + source.id, false);
      f.event('doc.share-state.changed', source.id).next({ type: 'ready' });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.readableDocs).toEqual([]);
    expect(result.current.error).toContain('Could not verify');
  });

  it('bounds concurrent loads and coalesces refreshes without starving a slow scan', async () => {
    const f = setup();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    for (let i = 0; i < 12; i++) {
      const doc = f.addDoc(`slow-${i}`, `Task ${i}`, true);
      f.grant(doc.id);
      doc.waitForSyncReady.mockImplementation(() => gate);
    }
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    let refreshed!: Promise<void>;
    await act(async () => {
      refreshed = result.current.refresh();
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish();
      await refreshed;
    });
    await waitFor(() => expect(result.current.tasks).toHaveLength(12));
    expect(result.current.loading).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(12);
    expect(f.docsService.open).not.toHaveBeenCalled();
  });

  it('skips hidden fallback sweeps but still invalidates revoked task access', async () => {
    const f = setup();
    f.addDoc('task', 'Task', true);
    f.grant('task');
    vi.useFakeTimers();
    const { result } = renderHook(() => useTasks());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tasks).toHaveLength(1);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    const can = fixture.services.guardService.can;
    can.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      window.dispatchEvent(new Event('focus'));
    });
    expect(can).not.toHaveBeenCalled();
    await act(async () => {
      f.permissions.set('Doc_Read:task', false);
      f.event('doc.share-state.changed', 'task').next({ type: 'changed' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tasks).toEqual([]);
    expect(can).toHaveBeenCalledWith('Doc_Read', 'task');
  });

  it('uses five-minute visible sweeps and bounds focus refreshes without blocking explicit refresh', async () => {
    const f = setup();
    f.addDoc('task', 'Task', true);
    f.grant('task');
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { result } = renderHook(() => useTasks());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.tasks).toHaveLength(1);
    const can = fixture.services.guardService.can;
    can.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299999);
    });
    expect(can).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(can).toHaveBeenCalledWith('Doc_Read', 'task');
    can.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(can).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.refresh();
    });
    expect(can).toHaveBeenCalledWith('Doc_Read', 'task');
    can.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(can).toHaveBeenCalledWith('Doc_Read', 'task');
  });

  it('finishes with explicit incomplete coverage when one document never loads', async () => {
    vi.useFakeTimers();
    const f = setup();
    const slow = f.addDoc('unavailable', 'Unavailable', true);
    slow.waitForSyncReady.mockImplementation(() => new Promise(() => {}));
    f.grant(slow.id);
    f.addDoc('available', 'Available task', true);
    f.grant('available');
    const { result } = renderHook(() => useTasks());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.tasks.map(task => task.id)).toEqual(['available']);
    expect(result.current.error).toContain('may be incomplete');
    expect(result.current.readableDocs.map(doc => doc.id)).toEqual([
      'available',
    ]);
  });

  it('reads authorized snapshots without opening editors or scheduling sync writes', async () => {
    const f = setup();
    const task = f.addDoc('allowed-task', 'Task');
    task.yDoc.getMap(TASK_MAP).set('schemaVersion', 1);
    f.addDoc('denied-source', 'Private source');
    f.grant('allowed-task');
    const retry =
      fixture.services.workspaceService.workspace.engine.doc.retryDoc;
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(retry).not.toHaveBeenCalled();
    expect(
      f.fetch.mock.calls.map(([path]: [string]) => path.split('/').at(-2))
    ).toEqual(['allowed-task']);
    expect(f.docsService.open).not.toHaveBeenCalled();
    expect(
      fixture.services.workspaceService.workspace.engine.doc.storage
        .pushDocUpdate
    ).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.refresh();
    });
    expect(retry).not.toHaveBeenCalled();
    expect(
      f.fetch.mock.calls.map(([path]: [string]) => path.split('/').at(-2))
    ).toEqual(['allowed-task']);
    expect(f.docsService.open).not.toHaveBeenCalled();
    expect(
      fixture.services.workspaceService.workspace.engine.doc.storage
        .pushDocUpdate
    ).not.toHaveBeenCalled();
    f.grant('denied-source');
    await act(async () => {
      await result.current.refresh();
    });
    expect(retry).not.toHaveBeenCalled();
    expect(
      f.fetch.mock.calls.map(([path]: [string]) => path.split('/').at(-2))
    ).toEqual(['allowed-task', 'denied-source']);
    expect(f.docsService.open).not.toHaveBeenCalled();
  });

  it('resolves source relations arriving after the document is load-ready', async () => {
    const f = setup();
    const task = f.addDoc('hydrated-task', 'Task');
    task.yDoc.getMap(TASK_MAP).set('schemaVersion', 1);
    task.yDoc.getMap(TASK_MAP).set('linkToken', 'opaque-hydration-token');
    const source = f.addDoc('hydrated-source', 'Source');
    f.grant('hydrated-task', true);
    f.grant('hydrated-source');
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.tasks[0].linkedDocIds).toEqual([]);
    await act(async () => {
      source.yDoc.getMap(SOURCE_TASKS_MAP).set('opaque-hydration-token', true);
    });
    await waitFor(() =>
      expect(result.current.tasks[0].linkedDocIds).toEqual(['hydrated-source'])
    );
  });

  it('ignores initial readiness but revalidates permissions on reconnect', async () => {
    const f = setup();
    const doc = f.addDoc('ready-task', 'Ready task');
    doc.yDoc.getMap(TASK_MAP).set('schemaVersion', 1);
    f.grant('ready-task', true);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    const before = fixture.services.guardService.can.mock.calls.length;
    await act(async () => {
      f.event('workspace.access.changed').next({ type: 'ready' });
      f.event('doc.share-state.changed', 'ready-task').next({ type: 'ready' });
    });
    await waitFor(() =>
      expect(
        fixture.services.guardService.can.mock.calls.length
      ).toBeGreaterThan(before)
    );
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  });

  it('excludes unreadable documents and private links from hook output', async () => {
    const f = setup();
    const task = f.addDoc('public-task', 'Shared work', true);
    f.addDoc('private-source', 'Confidential strategy');
    f.addDoc('private-task', 'Confidential task', true);
    task.yDoc.getMap(TASK_LINKS_MAP).set('private-source', true);
    f.grant('public-task');
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks.map(t => t.id)).toEqual(['public-task']);
    expect(result.current.tasks[0].linkedDocIds).toEqual([]);
    expect(JSON.stringify(result.current.readableDocs)).not.toContain(
      'Confidential'
    );
    expect(f.docsService.open).not.toHaveBeenCalledWith('private-source');
    expect(f.docsService.open).not.toHaveBeenCalledWith('private-task');
  });

  it('skips explicit server Doc.Read denials without disclosing diagnostic IDs or hiding readable tasks', async () => {
    const f = setup();
    f.addDoc('private-id-sensitive', 'Confidential title');
    f.addDoc('task', 'Readable task', true);
    f.grant('task');
    const normal = fixture.services.guardService.can;
    fixture.services.guardService.can = vi.fn(
      async (action: string, id: string) => {
        if (id === 'private-id-sensitive')
          throw new UserFriendlyError({
            status: 403,
            code: 'DOC_ACTION_DENIED',
            type: 'DOC_ACTION_DENIED',
            name: 'DOC_ACTION_DENIED',
            message:
              'You do not have permission to perform Doc.Read action on doc private-id-sensitive',
          });
        return normal(action, id);
      }
    );
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks.map(t => t.id)).toEqual(['task']);
    expect(result.current.error).toBeNull();
    expect(JSON.stringify(result.current.readableDocs)).not.toContain(
      'private-id-sensitive'
    );
    expect(f.docsService.open).not.toHaveBeenCalledWith('private-id-sensitive');
  });

  it('fails closed with a generic error on network failures rather than treating them as denied access', async () => {
    const f = setup();
    f.addDoc('private-id-sensitive', 'Confidential title');
    fixture.services.guardService.can = vi.fn(
      async (_action: string, id: string) => {
        if (id) throw new Error('Network failure for private-id-sensitive');
        return true;
      }
    );
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.canCreate).toBe(false);
    expect(result.current.error).toContain('Could not verify');
    expect(result.current.error).not.toContain('private-id-sensitive');
  });

  it('rejects updates by a reader without changing the task or its history', async () => {
    const f = setup();
    const task = f.addDoc('task', 'Shared work', true);
    f.grant('task');
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(
      result.current.updateTask('task', { status: 'done' })
    ).rejects.toThrow('permission');
    expect(task.yDoc.getMap(TASK_MAP).get('status')).toBeUndefined();
    expect(task.yDoc.getMap(TASK_HISTORY_MAP).size).toBe(0);
  });

  it('clears revoked task access after a workspace access event', async () => {
    const f = setup();
    f.addDoc('task', 'Shared work', true);
    f.grant('task', true);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await act(async () => {
      f.permissions.set('Doc_Read:task', false);
      f.permissions.set('Doc_Update:task', false);
      f.event('workspace.access.changed').next({ changed: true });
    });
    await waitFor(() => expect(result.current.tasks).toEqual([]));
    expect(result.current.readableDocs).toEqual([]);
  });

  it('does not disclose a private source identifier in a broader task document', async () => {
    const f = setup();
    const task = f.addDoc('shared-task', 'Shared work', true);
    f.addDoc('private-source', 'Confidential strategy');
    f.grant('shared-task', true);
    f.grant('private-source', true);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.linkDocument('shared-task', 'private-source');
    });
    // Any authorized task reader receives the whole task Yjs document, not
    // merely the filtered React view. Inspect the recipient's actual replica.
    const recipient = new YDoc();
    applyUpdate(recipient, encodeStateAsUpdate(task.yDoc));
    const received = {
      links: recipient.getMap(TASK_LINKS_MAP).toJSON(),
      references: recipient.getArray('reference-fixture').toJSON(),
    };
    expect(JSON.stringify(received)).not.toContain('private-source');
    expect(f.docsService.addLinkedDoc).not.toHaveBeenCalled();
    expect(
      result.current.tasks.find(t => t.id === 'shared-task')?.linkedDocIds
    ).toEqual(['private-source']);
    await act(async () => {
      f.permissions.set('Doc_Read:private-source', false);
      f.permissions.set('Doc_Update:private-source', false);
      f.event('doc.share-state.changed', 'private-source').next({
        changed: true,
      });
    });
    await waitFor(() =>
      expect(
        result.current.tasks.find(t => t.id === 'shared-task')?.linkedDocIds
      ).toEqual([])
    );
    expect(JSON.stringify(result.current.readableDocs)).not.toContain(
      'Confidential strategy'
    );
    recipient.destroy();
  });

  it('does not disclose a private task identifier in a broader source document', async () => {
    const f = setup();
    f.addDoc('private-task', 'Confidential work', true);
    const source = f.addDoc('shared-source', 'Shared context');
    f.grant('private-task', true);
    f.grant('shared-source', true);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.linkDocument('private-task', 'shared-source');
    });
    const recipient = new YDoc();
    applyUpdate(recipient, encodeStateAsUpdate(source.yDoc));
    const raw = {
      relations: recipient.getMap(SOURCE_TASKS_MAP).toJSON(),
      references: recipient.getArray('reference-fixture').toJSON(),
    };
    expect(Object.keys(raw.relations)).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain('private-task');
    expect(JSON.stringify(raw)).not.toContain('Confidential work');
    await act(async () => {
      f.permissions.set('Doc_Read:private-task', false);
      f.permissions.set('Doc_Update:private-task', false);
      await result.current.refresh();
    });
    expect(result.current.tasks).toEqual([]);
    expect(result.current.readableDocs).toEqual([
      { id: 'shared-source', title: 'Shared context', canEdit: true },
    ]);
    recipient.destroy();
  });

  it('requires edit access on the source and rejects legacy task-owned links', async () => {
    const f = setup();
    const task = f.addDoc('task', 'Work', true);
    const source = f.addDoc('source', 'Context');
    f.grant('task', true);
    f.grant('source');
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.linkDocument('task', 'source')).rejects.toThrow(
      'permission'
    );
    expect(source.yDoc.getMap(SOURCE_TASKS_MAP).size).toBe(0);
    f.grant('source', true);
    task.yDoc.getMap(TASK_LINKS_MAP).set('old-source', true);
    await expect(result.current.linkDocument('task', 'source')).rejects.toThrow(
      'legacy links'
    );
    expect(source.yDoc.getMap(SOURCE_TASKS_MAP).size).toBe(0);
  });

  it('syncs a newly created task before snapshot discovery and returns it without reopening other docs', async () => {
    const f = setup();
    f.permissions.set('Workspace_CreateDoc:', true);
    const context = f.addDoc('existing-context', 'Existing document');
    f.grant(context.id);
    f.docsService.createDoc.mockImplementation(
      ({ title }: { title: string }) => {
        const doc = f.addDoc('new-task', title);
        f.grant(doc.id, true);
        return f.docsService.list.doc$(doc.id).value;
      }
    );
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let id: string | undefined;
    await act(async () => {
      id = await result.current.createTask({ title: 'New work' });
    });
    await waitFor(() =>
      expect(result.current.tasks.map(task => task.id)).toEqual(['new-task'])
    );
    expect(id).toBe('new-task');
    expect(
      fixture.services.workspaceService.workspace.engine.doc.waitForSynced
    ).toHaveBeenCalledWith('new-task', expect.any(AbortSignal));
    expect(f.docsService.open.mock.calls).toEqual([['new-task']]);
  });

  it('allows accepted members and unassignment', async () => {
    const f = setup();
    const task = f.addDoc('task', 'Work', true);
    f.grant('task', true);
    f.members.push({ id: 'accepted-user', status: 'Accepted' });
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.updateTask('task', { assigneeId: 'accepted-user' });
    });
    expect(task.yDoc.getMap(TASK_MAP).get('assigneeId')).toBe('accepted-user');
    await act(async () => {
      await result.current.updateTask('task', { assigneeId: null });
    });
    expect(task.yDoc.getMap(TASK_MAP).get('assigneeId')).toBeNull();
  });

  it('rejects assigning work to an unaccepted workspace invite', async () => {
    const f = setup();
    f.addDoc('task', 'Shared work', true);
    f.grant('task', true);
    f.members.push({ id: 'pending-user', status: 'Pending' });
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(
      result.current.updateTask('task', { assigneeId: 'pending-user' })
    ).rejects.toThrow();
  });
  it('cleans only current legacy links with edit permission, preserving prose and unrelated references', async () => {
    const f = setup();
    const task = f.addDoc('task', 'Work', true);
    const source = f.addDoc('private-source', 'Private context');
    const other = f.addDoc('other', 'Other context');
    f.grant('task');
    const links = task.yDoc.getMap(TASK_LINKS_MAP);
    links.set('private-source', true);
    const body = task.yDoc.getText('body');
    body.applyDelta([
      { insert: 'Keep private-source as plain text. ' },
      {
        insert: ' ',
        attributes: {
          reference: { type: 'LinkedPage', pageId: 'private-source' },
        },
      },
      {
        insert: 'Keep this label',
        attributes: {
          reference: { type: 'LinkedPage', pageId: 'private-source' },
          bold: true,
        },
      },
      {
        insert: ' ',
        attributes: { reference: { type: 'LinkedPage', pageId: 'other' } },
      },
    ]);
    const sourceBefore = encodeStateAsUpdate(source.yDoc);
    const otherBefore = encodeStateAsUpdate(other.yDoc);
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.removeLegacyLinks('task')).rejects.toThrow(
      'permission'
    );
    expect(links.size).toBe(1);
    f.grant('task', true);
    await act(async () => {
      await result.current.removeLegacyLinks('task');
    });
    expect(links.size).toBe(0);
    expect(body.toString()).toBe(
      'Keep private-source as plain text. Keep this label '
    );
    expect(
      body
        .toDelta()
        .some(
          (part: any) => part.attributes?.reference?.pageId === 'private-source'
        )
    ).toBe(false);
    expect(
      body
        .toDelta()
        .some((part: any) => part.attributes?.reference?.pageId === 'other')
    ).toBe(true);
    expect(
      body
        .toDelta()
        .some(
          (part: any) =>
            part.insert === 'Keep this label' && part.attributes?.bold === true
        )
    ).toBe(true);
    expect(encodeStateAsUpdate(source.yDoc)).toEqual(sourceBefore);
    expect(encodeStateAsUpdate(other.yDoc)).toEqual(otherBefore);
    expect(result.current.tasks[0].legacyLinksDetected).toBe(false);
    expect(task.yDoc.getMap(TASK_HISTORY_MAP).size).toBe(1);
    expect(
      JSON.stringify(task.yDoc.getMap(TASK_HISTORY_MAP).toJSON())
    ).not.toContain('private-source');
  });
});
