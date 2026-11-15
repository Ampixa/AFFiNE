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
        engine: { doc: { retryDoc: vi.fn(async () => {}) } },
      },
    },
    workspaceServerService: {
      server: {
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
  };
}

afterEach(() => cleanup());
beforeEach(() => {
  fixture.services = {};
});

describe('task security boundaries (mocked services, real hook and Yjs)', () => {
  it('requests targeted cloud hydration only for authorized newly opened documents', async () => {
    const f = setup();
    const task = f.addDoc('allowed-task', 'Task');
    task.yDoc.getMap(TASK_MAP).set('schemaVersion', 1);
    f.addDoc('denied-source', 'Private source');
    f.grant('allowed-task');
    const retry =
      fixture.services.workspaceService.workspace.engine.doc.retryDoc;
    const { result } = renderHook(() => useTasks());
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(retry.mock.calls).toEqual([['allowed-task']]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(retry.mock.calls).toEqual([['allowed-task']]);
    f.grant('denied-source');
    await act(async () => {
      await result.current.refresh();
    });
    expect(retry.mock.calls).toEqual([['allowed-task'], ['denied-source']]);
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
