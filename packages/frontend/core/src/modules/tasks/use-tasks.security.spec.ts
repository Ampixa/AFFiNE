// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { BehaviorSubject, startWith, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../permissions', () => ({ GuardService: class {} }));
vi.mock('../storage', () => ({ NbstoreService: class {} }));
vi.mock('../workspace', () => ({ WorkspaceService: class {} }));
import { useTasks } from './use-tasks';

const task = (patch: Record<string, unknown> = {}) => ({
  id: 'task-1',
  title: 'Independent task',
  description: 'Finish the release',
  status: 'ready',
  priority: 'normal',
  assigneeId: null,
  dueDate: null,
  blockedReason: '',
  archived: false,
  linkedDocIds: [],
  detailDocId: null,
  history: [],
  updatedAt: 100,
  canEdit: true,
  ...patch,
});
function setup() {
  const events = new Map<string, Subject<any>>();
  const event = (topic: string, docId = '') => {
    const key = topic + ':' + docId;
    if (!events.has(key)) events.set(key, new Subject());
    return events.get(key)!;
  };
  const state = {
    tasks: [task()],
    linkedDocs: [] as any[],
    contextDocs: [] as any[],
    canCreate: true,
    deny: false,
  };
  const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
    if (state.deny) throw new Error('Forbidden');
    const url = new URL(path, 'https://test.invalid');
    let result: unknown;
    if (url.pathname.endsWith('/context-docs'))
      result = { docs: state.contextDocs, nextCursor: null };
    else if (url.pathname.endsWith('/tasks')) {
      if (init.method === 'POST')
        result = task({ ...JSON.parse(init.body as string), id: 'created-1' });
      else
        result = {
          tasks: state.tasks,
          linkedDocs: state.linkedDocs,
          canCreate: state.canCreate,
          nextCursor: null,
        };
    } else
      result = task(
        init.method === 'PATCH' ? JSON.parse(init.body as string) : {}
      );
    return { status: 200, json: async () => result };
  });
  const account$ = new BehaviorSubject({ id: 'member-1' });
  fixture.services = {
    workspaceService: {
      workspace: {
        id: 'workspace-1',
        flavour: 'affine-cloud',
        openOptions: {},
      },
    },
    workspaceServerService: {
      server: { fetch, scope: { get: () => ({ session: { account$ } }) } },
    },
    nbstoreService: {
      realtime: {
        subscribe: vi.fn((topic: string, { docId }: { docId?: string }) =>
          event(topic, docId).pipe(startWith({ type: 'ready' }))
        ),
      },
    },
    guardService: { can: vi.fn(async () => true) },
    // Prove discovery never invokes document services even when available.
    docsService: {
      open: vi.fn(),
      list: {
        nonTrashDocsIds$: new BehaviorSubject(
          Array.from({ length: 1000 }, (_, n) => `doc-${n}`)
        ),
      },
    },
  };
  return { state, fetch, event };
}
beforeEach(() => {
  document.cookie = 'affine_csrf_token=test-csrf; path=/';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('database task reads and access invalidation', () => {
  it('loads tasks with one list request regardless of workspace document count', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][0]).toBe(
      '/api/workspaces/workspace-1/tasks?limit=100'
    );
    expect(fixture.services.docsService.open).not.toHaveBeenCalled();
    expect(result.current.canCreate).toBe(true);
    expect(result.current.currentUserId).toBe('member-1');
  });
  it('follows opaque cursors including empty permission-filtered pages', async () => {
    const f = setup();
    f.fetch.mockImplementation(async (path: string) => ({
      status: 200,
      json: async () =>
        path.includes('cursor=')
          ? {
              tasks: [task()],
              linkedDocs: [],
              canCreate: true,
              nextCursor: null,
            }
          : { tasks: [], linkedDocs: [], canCreate: true, nextCursor: '100' },
    }));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[1][0]).toContain('cursor=100');
  });
  it('rejects repeating pagination instead of silently returning partial tasks', async () => {
    const f = setup();
    f.fetch.mockImplementation(async () => ({
      status: 200,
      json: async () => ({
        tasks: [],
        linkedDocs: [],
        canCreate: true,
        nextCursor: '100',
      }),
    }));
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.error).toContain('pagination'));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.canCreate).toBe(false);
  });
  it('uses server-side document filtering for the related task panel', async () => {
    const f = setup();
    renderHook(() => useTasks({ docId: 'source/private' }));
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    expect(f.fetch.mock.calls[0][0]).toContain('docId=source%2Fprivate');
  });
  it('clears open private context immediately on revocation and discards stale requests', async () => {
    const f = setup();
    f.state.tasks = [task({ linkedDocIds: ['private'] })];
    f.state.linkedDocs = [
      { id: 'private', title: 'Secret source', canEdit: true },
    ];
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.readableDocs).toHaveLength(1));
    let resolve: ((value: any) => void) | undefined;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    );
    let oldRequest: Promise<void>;
    act(() => {
      oldRequest = result.current.refresh();
    });
    f.state.tasks = [task()];
    f.state.linkedDocs = [];
    act(() =>
      f.event('doc.grants.changed', 'private').next({ type: 'changed' })
    );
    expect(result.current.readableDocs).toEqual([]);
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await act(async () => {
      resolve!({
        status: 200,
        json: async () => ({
          tasks: [task({ linkedDocIds: ['private'] })],
          linkedDocs: [{ id: 'private', title: 'Secret source' }],
          canCreate: true,
          nextCursor: null,
        }),
      });
      await oldRequest!;
    });
    expect(result.current.readableDocs).toEqual([]);
    expect(result.current.tasks[0].linkedDocIds).toEqual([]);
  });
  it('fails closed when workspace membership is revoked', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    f.state.deny = true;
    act(() => f.event('workspace.access.changed').next({ type: 'changed' }));
    expect(result.current.tasks).toEqual([]);
    await waitFor(() => expect(result.current.error).toBe('Forbidden'));
    expect(result.current.canCreate).toBe(false);
  });
  it('disconnect clears previously authorized data until access can be verified', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    act(() => f.event('workspace.access.changed').error(new Error('offline')));
    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toContain('disconnected');
  });
  it('does not discover or mutate local-only document tasks', async () => {
    const f = setup();
    fixture.services.workspaceService.workspace.flavour = 'local';
    const { result } = renderHook(() => useTasks());
    expect(result.current.available).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(fixture.services.docsService.open).not.toHaveBeenCalled();
  });
  it('searches context lazily and never opens document bodies', async () => {
    const f = setup();
    f.state.contextDocs = [{ id: 'doc-1', title: 'Research', canEdit: true }];
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.searchDocuments(''));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await act(() => result.current.searchDocuments('Research'));
    expect(result.current.contextDocs).toHaveLength(1);
    expect(
      f.fetch.mock.calls.some(([path]) =>
        path.includes('/context-docs?q=Research')
      )
    ).toBe(true);
    expect(fixture.services.docsService.open).not.toHaveBeenCalled();
  });
  it('sends CSRF and optimistic version for independent task field edits', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await act(() =>
      result.current.updateTask(
        'task-1',
        { description: 'No document needed', archived: false },
        100
      )
    );
    const call = f.fetch.mock.calls.find(
      ([, init]) => init?.method === 'PATCH'
    )!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      description: 'No document needed',
      archived: false,
      expectedUpdatedAt: 100,
    });
    expect(call[1]!.headers).toMatchObject({
      'x-affine-csrf-token': 'test-csrf',
    });
  });
  it('never retries an uncertain create request automatically', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    f.fetch.mockImplementationOnce(async () => {
      throw new Error('Network disconnected');
    });
    await expect(
      result.current.createTask({ title: 'New task' })
    ).rejects.toThrow('Network disconnected');
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    ).toHaveLength(1);
  });
  it('subscribes concurrent linked-document additions before publishing the refreshed list', async () => {
    const f = setup();
    let reads = 0;
    f.fetch.mockImplementation(async () => {
      reads++;
      const docs =
        reads === 1
          ? [{ id: 'a', title: 'A', canEdit: true }]
          : [
              { id: 'a', title: 'A', canEdit: true },
              { id: 'b', title: 'B', canEdit: true },
            ];
      return {
        status: 200,
        json: async () => ({
          tasks: [task({ linkedDocIds: docs.map(doc => doc.id) })],
          linkedDocs: docs,
          canCreate: true,
          nextCursor: null,
        }),
      };
    });
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.readableDocs).toHaveLength(2));
    expect(reads).toBe(3);
    expect(
      fixture.services.nbstoreService.realtime.subscribe
    ).toHaveBeenCalledWith('doc.grants.changed', {
      workspaceId: 'workspace-1',
      docId: 'b',
    });
  });
  it('rejects a stale detail response after workspace access changes', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let resolve: ((value: any) => void) | undefined;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    );
    const detail = result.current.loadTask('task-1');
    const rejected = expect(detail).rejects.toThrow('access changed');
    act(() => f.event('workspace.access.changed').next({ type: 'changed' }));
    await act(async () => {
      resolve!({
        status: 200,
        json: async () => task({ title: 'Old private result' }),
      });
      await rejected;
    });
    expect(
      result.current.tasks.some(value => value.title === 'Old private result')
    ).toBe(false);
  });
  it('reports a confirmed save with failed verification without replaying the mutation', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    f.fetch.mockImplementationOnce(async () => ({
      status: 200,
      json: async () => task({ updatedAt: 101 }),
    }));
    f.fetch.mockImplementationOnce(async () => {
      throw new Error('Forbidden');
    });
    await act(async () => {
      await expect(
        result.current.updateTask('task-1', { status: 'done' }, 100)
      ).rejects.toThrow('Task saved, but current access');
    });
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
    ).toHaveLength(1);
    expect(result.current.tasks).toEqual([]);
  });
});

describe('task conversation request boundaries', () => {
  const comment = {
    id: 'c1',
    actorId: 'member-1',
    body: 'Context',
    createdAt: 100,
    updatedAt: 100,
    edited: false,
    canEdit: true,
  };
  it('keeps loaded conversation when task list refreshes', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    f.fetch.mockImplementationOnce(async () => ({
      status: 200,
      json: async () => task({ comments: [comment] }),
    }));
    await act(async () => {
      await result.current.loadTask('task-1');
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.tasks[0].comments).toEqual([comment]);
  });
  it('does not restore a late conversation page after membership revocation', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let resolve: ((value: any) => void) | undefined;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r;
        })
    );
    const request = result.current.loadMoreComments('task-1', 50);
    const rejected = expect(request).rejects.toThrow('access changed');
    f.state.deny = true;
    act(() => f.event('workspace.access.changed').next({ type: 'changed' }));
    await act(async () => {
      resolve!({ status: 200, json: async () => [comment] });
      await rejected;
    });
    expect(result.current.tasks).toEqual([]);
  });
  it('pins comment edit version and includes CSRF without replaying ambiguous writes', async () => {
    const f = setup();
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    f.fetch.mockImplementationOnce(async () => {
      throw new Error('Connection lost');
    });
    await act(async () => {
      await expect(
        result.current.comment('task-1', 'Revision', comment)
      ).rejects.toThrow('Connection lost');
    });
    const writes = f.fetch.mock.calls.filter(
      ([, init]) => init?.method === 'PATCH'
    );
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(
      '/api/workspaces/workspace-1/tasks/task-1/comments/c1'
    );
    expect(JSON.parse(writes[0][1]!.body as string)).toEqual({
      body: 'Revision',
      expectedUpdatedAt: 100,
    });
    expect(
      (writes[0][1]!.headers as Record<string, string>)['x-affine-csrf-token']
    ).toBe('test-csrf');
  });
});
