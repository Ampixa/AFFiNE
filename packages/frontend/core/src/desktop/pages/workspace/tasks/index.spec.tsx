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
    isLocal: false,
    currentUserId: 'user-yash',
    refresh: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue('created-1'),
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
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(dialog().getByRole('button', { name: 'Close' }));
    expect(window.confirm).toHaveBeenCalledWith(
      'Discard your unsaved task changes?'
    );
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
  test('read-only context documents are visibly unavailable and cannot be submitted', async () => {
    state.value.contextDocs = state.value.readableDocs;
    state.value.readableDocs.push({
      id: 'read-only-source',
      title: 'Read-only context',
      canEdit: false,
    });
    render(<Component />);
    openTask();
    const source = dialog().getByLabelText('Context document');
    const option = within(source).getByRole('option', {
      name: 'Read-only context · read only',
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    fireEvent.change(source, { target: { value: 'read-only-source' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Save changes' }));
    expect(state.value.linkDocument).not.toHaveBeenCalled();
    expect(state.value.updateTask).not.toHaveBeenCalled();
    expect(dialog().getByRole('alert').textContent).toContain(
      'context document you can edit'
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
