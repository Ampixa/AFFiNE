/** @vitest-environment happy-dom */
import type { Task } from '@affine/core/modules/tasks/model';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ value: {} as any, openDoc: vi.fn() }));
vi.mock('@affine/core/modules/tasks/use-tasks', () => ({
  useTasks: () => state.value,
}));
vi.mock('@affine/component', () => ({
  ConfirmModal: ({
    open,
    title,
    description,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <p>{description}</p>
        <button onClick={onCancel}>{cancelText}</button>
        <button onClick={onConfirm}>{confirmText}</button>
      </div>
    ) : null,

  Button: ({
    children,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    variant?: string;
    [key: string]: unknown;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Modal: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
vi.mock('@affine/core/modules/workbench', () => ({
  WorkbenchService: class {},
  ViewBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ViewHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}));
vi.mock('@affine/core/modules/workbench/view/view-meta', () => ({
  ViewTitle: () => null,
  ViewIcon: () => null,
}));
vi.mock('@toeverything/infra', () => ({
  useService: () => ({ workbench: { openDoc: state.openDoc } }),
}));
vi.mock('@blocksuite/icons/rc', () => ({
  CheckBoxCheckLinearIcon: () => null,
  PlusIcon: () => null,
}));
// Preserve the real selector's contract: append clicked member, toggle selected off.
vi.mock('@affine/core/components/member-selector', () => ({
  MemberSelectorInline: ({
    selected,
    onChange,
    readonly,
    placeholder,
  }: {
    selected: string[];
    onChange: (ids: string[]) => void;
    readonly?: boolean;
    placeholder?: ReactNode;
  }) =>
    readonly ? (
      <span data-testid="member-display">
        {selected.join(',') || placeholder}
      </span>
    ) : (
      <div data-testid="member-selector">
        <span>{placeholder}</span>
        {['user-yash', 'user-voidash'].map(id => (
          <button
            type="button"
            key={id}
            aria-label={`Toggle ${id}`}
            onClick={() =>
              onChange(
                selected.includes(id)
                  ? selected.filter(x => x !== id)
                  : [...selected, id]
              )
            }
          >
            {id}
            {selected.includes(id) ? ' selected' : ''}
          </button>
        ))}
      </div>
    ),
}));
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams()],
}));
import { Component } from './index';

const ticket = (patch: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Review model evidence',
  description: '',
  detailDocId: 'task-1',
  status: 'ready',
  assigneeId: 'user-yash',
  priority: 'normal',
  dueDate: null,
  blockedReason: '',
  archived: false,
  linkedDocIds: [],
  history: [
    { id: 'event-1', actorId: 'user-voidash', at: 100, body: 'Created task.' },
  ],
  updatedAt: 100,
  canEdit: true,
  canAdmin: true,
  canLink: true,
  canComment: true,
  comments: [],
  ...patch,
});
const dialog = () => within(screen.getByRole('dialog'));
const openTask = () =>
  fireEvent.click(
    screen.getByRole('button', { name: 'Review model evidence' })
  );
beforeEach(() => {
  state.value = {
    tasks: [ticket()],
    loading: false,
    scanProgress: { completed: 1, total: 1 },
    error: null,
    contextDocs: [{ id: 'source-1', title: 'Research context', canEdit: true }],
    searchDocuments: vi.fn().mockResolvedValue(undefined),
    loadTask: vi.fn().mockResolvedValue(ticket()),
    contextLoading: false,
    hasMoreContext: false,
    loadMoreDocuments: vi.fn(),
    readableDocs: [
      { id: 'source-1', title: 'Research context', canEdit: true },
    ],
    canCreate: true,
    canAdmin: true,
    isLocal: false,
    currentUserId: 'user-yash',
    refresh: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue('created-1'),
    comment: vi.fn().mockResolvedValue(undefined),
    loadMoreComments: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockResolvedValue(ticket({ updatedAt: 101 })),
    linkDocument: vi.fn().mockResolvedValue(undefined),
    removeLegacyLinks: vi
      .fn()
      .mockResolvedValue(
        ticket({ updatedAt: 102, legacyLinksDetected: false })
      ),
  };
  state.openDoc.mockReset();
  Object.defineProperty(window, 'confirm', {
    value: vi.fn(() => true),
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('native workspace Tasks member and access interactions', () => {
  test('shows discovery progress and allows creation after access is verified', () => {
    state.value.loading = true;
    state.value.tasks = [];
    state.value.scanProgress = { completed: 12, total: 229 };
    render(<Component />);
    expect(screen.getByRole('status').textContent).toContain('Loading tasks');
    expect(screen.queryByText('Start with one small next step.')).toBeNull();
    const create = screen.getByRole('button', { name: 'New task' });
    expect(create.hasAttribute('disabled')).toBe(false);
    fireEvent.click(create);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  test('keeps creation disabled until access is verified and retains visible tasks during refresh', () => {
    state.value.loading = true;
    state.value.canCreate = false;
    state.value.scanProgress = { completed: 0, total: 0 };
    render(<Component />);
    expect(screen.getByRole('status').textContent).toBe('Loading tasks…');
    expect(
      screen.getByRole('button', { name: 'New task' }).hasAttribute('disabled')
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Review model evidence' })
    ).toBeTruthy();
  });
  test('delegation stores one real member ID and preserves pinned edit timestamp', async () => {
    render(<Component />);
    openTask();
    fireEvent.click(
      dialog().getByRole('button', { name: 'Toggle user-voidash' })
    );
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.value.updateTask).toHaveBeenCalledWith(
        'task-1',
        { assigneeId: 'user-voidash' },
        100
      )
    );
  });
  test('toggling the assigned person clears the owner', async () => {
    render(<Component />);
    openTask();
    fireEvent.click(dialog().getByRole('button', { name: 'Toggle user-yash' }));
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.value.updateTask).toHaveBeenCalledWith(
        'task-1',
        { assigneeId: null },
        100
      )
    );
  });
  test('My work uses authenticated current user rather than display name', () => {
    state.value.tasks = [
      ticket(),
      ticket({
        id: 'task-2',
        title: 'Other owner task',
        assigneeId: 'user-voidash',
      }),
    ];
    render(<Component />);
    fireEvent.click(screen.getByRole('button', { name: 'My work' }));
    expect(
      screen.queryByRole('button', { name: 'Other owner task' })
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Review model evidence' })
    ).toBeTruthy();
  });
  test('read-only member can open documents but cannot edit or archive task fields', () => {
    state.value.tasks = [ticket({ canEdit: false })];
    state.value.canCreate = false;
    render(<Component />);
    openTask();
    expect(
      (dialog().getByLabelText('Title') as HTMLInputElement).disabled
    ).toBe(true);
    expect(dialog().queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(dialog().queryByRole('button', { name: 'Archive' })).toBeNull();
    fireEvent.click(
      dialog().getByRole('button', { name: 'Open original document' })
    );
    expect(state.openDoc).toHaveBeenCalledWith('task-1');
  });
  test('revoked access conceals the already-open task instead of retaining editable stale details', () => {
    const ui = render(<Component />);
    openTask();
    state.value = { ...state.value, tasks: [] };
    ui.rerender(<Component />);
    expect(dialog().queryByLabelText('Title')).toBeNull();
    expect(dialog().getByRole('alert').textContent).toContain(
      'no longer available'
    );
  });
  test('permission downgrade disables the current form even though its initial snapshot allowed edit', () => {
    const ui = render(<Component />);
    openTask();
    state.value = { ...state.value, tasks: [ticket({ canEdit: false })] };
    ui.rerender(<Component />);
    expect(
      (dialog().getByLabelText('Title') as HTMLInputElement).disabled
    ).toBe(true);
    expect(dialog().queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
  test('activity resolves actors through member IDs and local mode exposes no team selector', () => {
    const ui = render(<Component />);
    openTask();
    expect(
      dialog()
        .getAllByTestId('member-display')
        .some(el => el.textContent === 'user-voidash')
    ).toBe(true);
    state.value = { ...state.value, isLocal: true, currentUserId: null };
    ui.rerender(<Component />);
    expect(dialog().queryByTestId('member-selector')).toBeNull();
    expect(dialog().getByText('Unassigned in local preview')).toBeTruthy();
  });
  test('blocked task requires an explanation before mutation', () => {
    render(<Component />);
    openTask();
    fireEvent.change(dialog().getByLabelText('Status'), {
      target: { value: 'blocked' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    expect(state.value.updateTask).not.toHaveBeenCalled();
    expect(dialog().getByRole('alert').textContent).toContain('Explain');
  });
  test('failed context-link retry uses the saved baseline instead of replaying an old version', async () => {
    state.value.linkDocument.mockRejectedValueOnce(
      new Error('Context access changed.')
    );
    render(<Component />);
    openTask();
    fireEvent.change(dialog().getByLabelText('Title'), {
      target: { value: 'Updated title' },
    });
    state.value.updateTask.mockResolvedValue(
      ticket({ title: 'Updated title', updatedAt: 101 })
    );
    fireEvent.change(dialog().getByLabelText('Context document'), {
      target: { value: 'source-1' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(dialog().getByRole('alert').textContent).toContain(
        'Context access changed'
      )
    );
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.value.updateTask).toHaveBeenLastCalledWith('task-1', {}, 101)
    );
    expect(state.value.linkDocument).toHaveBeenCalledTimes(2);
  });
  test('partially created task retries its link without creating a duplicate task', async () => {
    const created = ticket({
      id: 'created-1',
      title: 'New task title',
      assigneeId: null,
      updatedAt: 200,
    });
    state.value.createTask.mockImplementation(async () => {
      state.value.tasks = [...state.value.tasks, created];
      throw Object.assign(
        new Error('Task created but context could not be linked.'),
        { createdTask: created, createdTaskId: created.id }
      );
    });
    render(<Component />);
    fireEvent.click(screen.getByRole('button', { name: /New task/ }));
    fireEvent.change(dialog().getByLabelText('Title'), {
      target: { value: 'New task title' },
    });
    fireEvent.change(dialog().getByLabelText('Context document'), {
      target: { value: 'source-1' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(dialog().getByRole('alert').textContent).toContain('Task created')
    );
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.value.linkDocument).toHaveBeenCalledWith(
        'created-1',
        'source-1'
      )
    );
    expect(state.value.createTask).toHaveBeenCalledTimes(1);
  });
  test('private inaccessible sources absent from hook are not offered by the source picker', () => {
    render(<Component />);
    openTask();
    const options = within(dialog().getByLabelText('Context document'))
      .getAllByRole('option')
      .map(el => el.textContent);
    expect(options).toEqual(['Choose a document', 'Research context']);
  });
  test('context selection is treated as an unsaved change when closing', () => {
    render(<Component />);
    openTask();
    fireEvent.change(dialog().getByLabelText('Context document'), {
      target: { value: 'source-1' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Close' }));
    expect(
      screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(dialog().getByLabelText('Context document')).toBeTruthy();
  });
  test('conflict rejection preserves edited title and does not navigate or retry automatically', async () => {
    state.value.updateTask.mockRejectedValue(
      new Error('Task changed. Refresh before editing.')
    );
    render(<Component />);
    openTask();
    fireEvent.change(dialog().getByLabelText('Title'), {
      target: { value: 'My preserved draft' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(dialog().getByRole('alert').textContent).toContain('Task changed')
    );
    expect((dialog().getByLabelText('Title') as HTMLInputElement).value).toBe(
      'My preserved draft'
    );
    expect(state.value.updateTask).toHaveBeenCalledTimes(1);
    expect(state.openDoc).not.toHaveBeenCalled();
  });
  test('members can link readable read-only documents to their own task', async () => {
    state.value.canAdmin = false;
    state.value.tasks = [ticket({ canAdmin: false, canLink: true })];
    state.value.contextDocs = state.value.readableDocs;
    state.value.readableDocs.push({
      id: 'read-only-source',
      title: 'Read-only context',
      canEdit: false,
    });
    render(<Component />);
    openTask();
    const source = dialog().getByLabelText('Context document');
    expect(
      (
        within(source).getByRole('option', {
          name: 'Read-only context',
        }) as HTMLOptionElement
      ).disabled
    ).toBe(false);
    fireEvent.change(source, { target: { value: 'read-only-source' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.value.linkDocument).toHaveBeenCalledWith(
        'task-1',
        'read-only-source'
      )
    );
  });
  test('members create a self-assigned task without assignment or priority controls', async () => {
    state.value.canAdmin = false;
    render(<Component />);
    fireEvent.click(screen.getAllByRole('button', { name: /New task/ })[0]);
    fireEvent.change(dialog().getByLabelText('Title'), {
      target: { value: 'My new task' },
    });
    expect(dialog().getByTestId('member-display').textContent).toContain(
      'user-yash'
    );
    expect(
      (dialog().getByLabelText('Priority') as HTMLSelectElement).disabled
    ).toBe(true);
    fireEvent.click(dialog().getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(state.value.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My new task',
          assigneeId: 'user-yash',
          priority: 'normal',
          dueDate: null,
        })
      )
    );
  });
  test('an untouched read-only dialog follows live status and owner changes', async () => {
    state.value.tasks = [ticket({ canEdit: false })];
    const ui = render(<Component />);
    openTask();
    state.value = {
      ...state.value,
      tasks: [
        ticket({
          canEdit: false,
          status: 'doing',
          assigneeId: 'user-voidash',
          updatedAt: 200,
        }),
      ],
    };
    ui.rerender(<Component />);
    await waitFor(() =>
      expect(
        (dialog().getByLabelText('Status') as HTMLSelectElement).value
      ).toBe('doing')
    );
    expect(
      dialog()
        .getAllByTestId('member-display')
        .some(el => el.textContent === 'user-voidash')
    ).toBe(true);
    expect(
      (dialog().getByLabelText('Title') as HTMLInputElement).disabled
    ).toBe(true);
  });
  test('live updates preserve dirty edits and the original conflict baseline', async () => {
    const ui = render(<Component />);
    openTask();
    fireEvent.change(dialog().getByLabelText('Title'), {
      target: { value: 'My unsaved title' },
    });
    state.value = {
      ...state.value,
      tasks: [
        ticket({ title: 'Remote title', status: 'doing', updatedAt: 200 }),
      ],
    };
    ui.rerender(<Component />);
    expect((dialog().getByLabelText('Title') as HTMLInputElement).value).toBe(
      'My unsaved title'
    );
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.value.updateTask).toHaveBeenCalledWith(
        'task-1',
        { title: 'My unsaved title' },
        100
      )
    );
  });
  test('creates an independent task with description without opening a document', async () => {
    state.value.tasks = [];
    render(<Component />);
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(dialog().getByLabelText('Title'), {
      target: { value: 'Prepare demo' },
    });
    fireEvent.change(dialog().getByLabelText('Description'), {
      target: { value: 'Record a short demo and review it.' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(state.value.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Prepare demo',
          description: 'Record a short demo and review it.',
          linkedDocIds: [],
        })
      )
    );
    expect(state.openDoc).not.toHaveBeenCalled();
  });
});

describe('task conversation and owner-only controls', () => {
  const ownComment = {
    id: 'c1',
    actorId: 'user-yash',
    body: 'See https://example.org/research',
    createdAt: 100,
    updatedAt: 100,
    edited: false,
    canEdit: true,
  };
  test('owner can edit progress and checklist but cannot change administration', async () => {
    state.value.canCreate = false;
    state.value.tasks = [
      ticket({
        canAdmin: false,
        description: '- [ ] Read context\n- [x] Record decision',
      }),
    ];
    render(<Component />);
    openTask();
    expect(
      (dialog().getByLabelText('Title') as HTMLInputElement).disabled
    ).toBe(true);
    expect(
      (dialog().getByLabelText('Priority') as HTMLSelectElement).disabled
    ).toBe(true);
    expect(
      (dialog().getByLabelText('Target date · optional') as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect(dialog().queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(dialog().queryByLabelText('Context document')).not.toBeNull();
    expect(dialog().queryByTestId('member-selector')).toBeNull();
    fireEvent.click(dialog().getByRole('checkbox', { name: 'Read context' }));
    fireEvent.change(dialog().getByLabelText('Status'), {
      target: { value: 'doing' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(state.value.updateTask).toHaveBeenCalledWith(
        'task-1',
        {
          status: 'doing',
          description: '- [x] Read context\n- [x] Record decision',
        },
        100
      )
    );
  });
  test('other member can comment without editing another owner’s task', async () => {
    state.value.tasks = [
      ticket({ canAdmin: false, canEdit: false, assigneeId: 'user-voidash' }),
    ];
    render(<Component />);
    openTask();
    expect(
      (dialog().getByLabelText('Description') as HTMLTextAreaElement).disabled
    ).toBe(true);
    fireEvent.change(dialog().getByLabelText('Add a comment'), {
      target: { value: 'Here is the context https://example.org' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Post comment' }));
    await waitFor(() =>
      expect(state.value.comment).toHaveBeenCalledWith(
        'task-1',
        'Here is the context https://example.org',
        undefined
      )
    );
    expect(state.value.updateTask).not.toHaveBeenCalled();
  });
  test('comment links are plain http(s) links and markup remains text', () => {
    state.value.tasks = [
      ticket({
        comments: [
          ownComment,
          {
            ...ownComment,
            id: 'c2',
            actorId: 'user-voidash',
            canEdit: false,
            edited: true,
            body: '<img src=x onerror=alert(1)> javascript:alert(1)',
          },
        ],
      }),
    ];
    render(<Component />);
    openTask();
    const link = dialog().getByRole('link', {
      name: 'https://example.org/research',
    });
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(dialog().queryByRole('img')).toBeNull();
    expect(
      dialog().getByText('<img src=x onerror=alert(1)> javascript:alert(1)')
    ).toBeTruthy();
    expect(
      dialog().getAllByRole('button', { name: 'Edit comment' })
    ).toHaveLength(1);
    expect(dialog().getByText(/· edited/)).toBeTruthy();
  });
  test('comment editor retains its initial revision when another edit arrives', async () => {
    state.value.tasks = [ticket({ comments: [ownComment] })];
    const ui = render(<Component />);
    openTask();
    fireEvent.click(dialog().getByRole('button', { name: 'Edit comment' }));
    fireEvent.change(dialog().getByLabelText('Edit your comment'), {
      target: { value: 'My edit' },
    });
    state.value = {
      ...state.value,
      tasks: [
        ticket({
          comments: [
            { ...ownComment, body: 'Concurrent change', updatedAt: 200 },
          ],
        }),
      ],
    };
    ui.rerender(<Component />);
    fireEvent.click(dialog().getByRole('button', { name: 'Save comment' }));
    await waitFor(() =>
      expect(state.value.comment).toHaveBeenCalledWith(
        'task-1',
        'My edit',
        ownComment
      )
    );
  });
  test('uncertain comment submission cannot be blindly replayed', async () => {
    state.value.comment.mockRejectedValueOnce(new Error('Connection lost'));
    render(<Component />);
    openTask();
    fireEvent.change(dialog().getByLabelText('Add a comment'), {
      target: { value: 'Keep my draft' },
    });
    fireEvent.click(dialog().getByRole('button', { name: 'Post comment' }));
    await waitFor(() =>
      expect(dialog().getByRole('alert').textContent).toContain(
        'Reopen the task'
      )
    );
    expect(
      (dialog().getByLabelText('Add a comment') as HTMLTextAreaElement).value
    ).toBe('Keep my draft');
    expect(
      dialog()
        .getByRole('button', { name: 'Post comment' })
        .hasAttribute('disabled')
    ).toBe(true);
    expect(state.value.comment).toHaveBeenCalledTimes(1);
  });
  test('membership revocation removes conversation and its composer', () => {
    state.value.tasks = [ticket({ comments: [ownComment] })];
    const ui = render(<Component />);
    openTask();
    state.value = { ...state.value, tasks: [] };
    ui.rerender(<Component />);
    expect(dialog().queryByText('Conversation')).toBeNull();
    expect(dialog().queryByRole('link')).toBeNull();
    expect(dialog().queryByLabelText('Add a comment')).toBeNull();
  });
  test('ownership change disables a dirty progress draft without dropping typed comment', () => {
    state.value.tasks = [ticket({ canAdmin: false })];
    const ui = render(<Component />);
    openTask();
    fireEvent.change(dialog().getByLabelText('Description'), {
      target: { value: 'Unsaved owner update' },
    });
    fireEvent.change(dialog().getByLabelText('Add a comment'), {
      target: { value: 'A question' },
    });
    state.value = {
      ...state.value,
      tasks: [
        ticket({
          assigneeId: 'user-voidash',
          canAdmin: false,
          canEdit: false,
          updatedAt: 200,
        }),
      ],
    };
    ui.rerender(<Component />);
    expect(
      (dialog().getByLabelText('Description') as HTMLTextAreaElement).disabled
    ).toBe(true);
    expect(dialog().queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(
      (dialog().getByLabelText('Add a comment') as HTMLTextAreaElement).value
    ).toBe('A question');
  });
  test('more conversation pages use the server cursor', async () => {
    state.value.tasks = [
      ticket({ comments: [ownComment], commentsNextCursor: 50 }),
    ];
    render(<Component />);
    openTask();
    fireEvent.click(
      dialog().getByRole('button', { name: 'Load earlier comments' })
    );
    await waitFor(() =>
      expect(state.value.loadMoreComments).toHaveBeenCalledWith('task-1', 50)
    );
  });
});
