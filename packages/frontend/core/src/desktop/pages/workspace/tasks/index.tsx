import { Button, ConfirmModal, Modal } from '@affine/component';
import { MemberSelectorInline } from '@affine/core/components/member-selector';
import type {
  Task,
  TaskPatch,
  TaskPriority,
  TaskStatus,
} from '@affine/core/modules/tasks/model';
import { useTasks } from '@affine/core/modules/tasks/use-tasks';
import {
  ViewBody,
  ViewHeader,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import {
  ViewIcon,
  ViewTitle,
} from '@affine/core/modules/workbench/view/view-meta';
import { CheckBoxCheckLinearIcon, PlusIcon } from '@blocksuite/icons/rc';
import { useService } from '@toeverything/infra';
import { useEffect, useMemo, useState } from 'react';

import * as styles from './index.css';

const labels: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  ready: 'Ready',
  doing: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  parked: 'Parked',
};
const statuses = Object.keys(labels) as TaskStatus[];
const priorities: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];
const colors: Record<TaskStatus, string> = {
  inbox: '#92929c',
  ready: '#748fb0',
  doing: '#bd924a',
  blocked: '#bc6575',
  review: '#9583b4',
  done: '#629c84',
  parked: '#8f9097',
};
type Draft = Pick<
  Task,
  'title' | 'status' | 'assigneeId' | 'priority' | 'dueDate' | 'blockedReason'
>;
const emptyDraft = (): Draft => ({
  title: '',
  status: 'inbox',
  assigneeId: null,
  priority: 'normal',
  dueDate: null,
  blockedReason: '',
});
const taskDraft = (task: Task): Draft => ({
  title: task.title,
  status: task.status,
  assigneeId: task.assigneeId,
  priority: task.priority,
  dueDate: task.dueDate,
  blockedReason: task.blockedReason,
});
const dateLabel = (date: string | null) =>
  date
    ? new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : '—';

export const Component = () => {
  const workspace = useTasks();
  const workbench = useService(WorkbenchService).workbench;
  const [scope, setScope] = useState('all');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [initialDraft, setInitialDraft] = useState('');
  const [documentSearch, setDocumentSearch] = useState('');

  const filtered = useMemo(
    () =>
      workspace.tasks
        .filter(
          t =>
            t.archived === (scope === 'archived') &&
            (scope !== 'mine' ||
              Boolean(
                workspace.currentUserId &&
                t.assigneeId === workspace.currentUserId
              )) &&
            (scope !== 'attention' ||
              t.status === 'blocked' ||
              t.status === 'review') &&
            (!statusFilter || t.status === statusFilter) &&
            (!priorityFilter || t.priority === priorityFilter) &&
            (!ownerFilter.length || ownerFilter.includes(t.assigneeId || '')) &&
            (!query || t.title.toLowerCase().includes(query.toLowerCase()))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [
      workspace.tasks,
      workspace.currentUserId,
      scope,
      statusFilter,
      priorityFilter,
      ownerFilter,
      query,
    ]
  );
  const counts = useMemo(
    () => ({
      open: workspace.tasks.filter(
        t => !t.archived && !['done', 'parked'].includes(t.status)
      ).length,
      blocked: workspace.tasks.filter(
        t => !t.archived && t.status === 'blocked'
      ).length,
      review: workspace.tasks.filter(t => !t.archived && t.status === 'review')
        .length,
    }),
    [workspace.tasks]
  );
  const sourceDocs = workspace.readableDocs.filter(
    d =>
      d.id !== selected?.id &&
      d.title.toLowerCase().includes(documentSearch.toLowerCase())
  );
  const current = selected
    ? workspace.tasks.find(t => t.id === selected.id)
    : null;
  const editable = selected ? Boolean(current?.canEdit) : workspace.canCreate;
  const dirty = JSON.stringify(draft) !== initialDraft || Boolean(sourceId);
  useEffect(() => {
    if (!open || !current || !selected || dirty) return;
    const nextDraft = taskDraft(current);
    if (
      current.updatedAt === selected.updatedAt &&
      current.canEdit === selected.canEdit &&
      current.archived === selected.archived &&
      JSON.stringify(nextDraft) === JSON.stringify(taskDraft(selected))
    )
      return;
    setSelected(current);
    setDraft(nextDraft);
    setInitialDraft(JSON.stringify(nextDraft));
  }, [current, selected, dirty, open]);
  const edit = (task?: Task) => {
    const d = task ? taskDraft(task) : emptyDraft();
    setSelected(task || null);
    setDraft(d);
    setInitialDraft(JSON.stringify(d));
    setSourceId('');
    setFormError('');
    setDocumentSearch('');
    setOpen(true);
  };
  const close = () => {
    if (busy) return;
    if (dirty && !window.confirm('Discard your unsaved task changes?')) return;
    setOpen(false);
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(d => ({ ...d, [key]: value }));
  const save = async () => {
    if (!editable || busy) return;
    if (sourceId) {
      const source = workspace.readableDocs.find(doc => doc.id === sourceId);
      if (
        current?.legacyLinksDetected ||
        !source ||
        !('canEdit' in source && source.canEdit === true)
      ) {
        setFormError(
          'Choose a context document you can edit. Legacy task links must be reviewed before adding more.'
        );
        return;
      }
    }
    if (!draft.title.trim()) {
      setFormError('Give the task a title.');
      return;
    }
    if (draft.status === 'blocked' && !draft.blockedReason.trim()) {
      setFormError('Explain what is blocking this task.');
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      if (selected) {
        const patch: TaskPatch = {};
        for (const key of Object.keys(draft) as (keyof Draft)[])
          if (draft[key] !== selected[key])
            Object.assign(patch, { [key]: draft[key] });
        const saved = await workspace.updateTask(
          selected.id,
          patch,
          selected.updatedAt
        );
        setSelected(saved);
        setInitialDraft(JSON.stringify(draft));
        if (sourceId) await workspace.linkDocument(selected.id, sourceId);
      } else {
        await workspace.createTask({
          ...draft,
          linkedDocIds: sourceId ? [sourceId] : [],
        });
      }
      setOpen(false);
      setNotice(
        selected
          ? 'Task updated.'
          : 'Task created. Open its document to add detail, checklist items, and comments.'
      );
    } catch (e) {
      if (e && typeof e === 'object' && 'createdTask' in e) {
        setSelected(e.createdTask as Task);
        setInitialDraft(JSON.stringify(draft));
      }
      setFormError(
        e instanceof Error
          ? e.message
          : 'Could not save this task. Your draft is preserved.'
      );
    } finally {
      setBusy(false);
    }
  };
  const removeLegacyLinks = async () => {
    if (!selected || !editable || busy) return;
    setBusy(true);
    setFormError('');
    try {
      const cleaned = await workspace.removeLegacyLinks(selected.id);
      setSelected(cleaned);
      setNotice(
        'Current legacy links removed. Task text and unrelated links were kept; historical copies may still retain removed references.'
      );
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : 'Could not remove legacy links.'
      );
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!selected || !editable || busy) return;
    if (
      dirty &&
      !window.confirm('Archive or restore without saving your other changes?')
    )
      return;
    setBusy(true);
    setFormError('');
    try {
      await workspace.updateTask(
        selected.id,
        { archived: !selected.archived },
        selected.updatedAt
      );
      setOpen(false);
      setNotice(
        selected.archived
          ? 'Task restored.'
          : 'Task archived. You can restore it from Archived.'
      );
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : 'Could not update this task.'
      );
    } finally {
      setBusy(false);
    }
  };
  const openDoc = (id: string) => {
    if (
      dirty &&
      !window.confirm('Open the document without saving these task changes?')
    )
      return;
    setOpen(false);
    workbench.openDoc(id);
  };
  const status = (t: Task) => (
    <span className={styles.status}>
      <span className={styles.dot} style={{ background: colors[t.status] }} />
      {labels[t.status]}
    </span>
  );
  const owner = (t: Task) => (
    <MemberSelectorInline
      selected={t.assigneeId ? [t.assigneeId] : []}
      readonly
      onChange={() => {}}
      placeholder="Unassigned"
    />
  );
  return (
    <>
      <ViewTitle title="Tasks" />
      <ViewIcon icon="allDocs" />
      <ViewHeader>
        <div className={styles.header}>
          <span className={styles.headerTitle}>
            <CheckBoxCheckLinearIcon />
            Tasks
          </span>
          <Button
            variant="primary"
            disabled={!workspace.canCreate}
            onClick={() => edit()}
          >
            <PlusIcon /> New task
          </Button>
        </div>
      </ViewHeader>
      <ViewBody>
        <div className={styles.body}>
          <div className={styles.intro}>
            <div>
              <h1 className={styles.heading}>Work, connected.</h1>
              <p className={styles.muted}>
                Tasks live alongside your documents. Clear ownership, flexible
                progress, no sprint required.
              </p>
            </div>
            <Button variant="plain" onClick={() => void workspace.refresh()}>
              Refresh
            </Button>
          </div>
          {workspace.isLocal && (
            <div className={styles.alert}>
              Local workspace preview. Document tasks persist here; real team
              assignment is available in a signed-in shared workspace.
            </div>
          )}
          {workspace.error && (
            <div className={styles.alert} role="alert">
              {workspace.error}
            </div>
          )}
          {notice && (
            <div className={styles.alert} role="status">
              {notice}{' '}
              <Button variant="plain" onClick={() => setNotice('')}>
                Dismiss
              </Button>
            </div>
          )}
          <div className={styles.toolbar}>
            <div className={styles.tabs}>
              {[
                ['all', 'All work'],
                ['mine', 'My work'],
                ['attention', 'Needs attention'],
                ['archived', 'Archived'],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  variant="plain"
                  className={scope === value ? styles.active : undefined}
                  onClick={() => setScope(value)}
                  disabled={value === 'mine' && !workspace.currentUserId}
                >
                  {label}
                </Button>
              ))}
            </div>
            <input
              className={styles.search}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search tasks…"
              aria-label="Search tasks"
            />
            <select
              className={styles.control}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              aria-label="Filter status"
            >
              <option value="">All statuses</option>
              {statuses.map(s => (
                <option key={s} value={s}>
                  {labels[s]}
                </option>
              ))}
            </select>
            <select
              className={styles.control}
              value={priorityFilter}
              onChange={e => setPriorityFilter(e.target.value)}
              aria-label="Filter priority"
            >
              <option value="">All priorities</option>
              {priorities.map(p => (
                <option key={p}>{p}</option>
              ))}
            </select>
            {!workspace.isLocal && (
              <MemberSelectorInline
                selected={ownerFilter}
                onChange={setOwnerFilter}
                placeholder="Filter owners"
              />
            )}
            <Button
              variant="plain"
              onClick={() => {
                setQuery('');
                setStatusFilter('');
                setPriorityFilter('');
                setOwnerFilter([]);
              }}
            >
              Reset
            </Button>
            <Button
              variant="plain"
              className={view === 'list' ? styles.active : undefined}
              onClick={() => setView('list')}
            >
              List
            </Button>
            <Button
              variant="plain"
              className={view === 'board' ? styles.active : undefined}
              onClick={() => setView('board')}
            >
              Board
            </Button>
          </div>
          <div className={styles.summary}>
            <span>{filtered.length} tasks shown</span>
            <span>{counts.open} open</span>
            <span>{counts.blocked} blocked</span>
            <span>{counts.review} ready for review</span>
          </div>
          {workspace.loading ? (
            <p className={styles.muted} role="status">
              Loading accessible tasks…
            </p>
          ) : !filtered.length ? (
            <div className={styles.empty}>
              <h3>
                {workspace.tasks.length
                  ? 'No tasks match this view.'
                  : 'Start with one small next step.'}
              </h3>
              <p>
                Each task is an AFFiNE document. Link the context, choose an
                owner, and keep work moving.
              </p>
              <Button
                variant="primary"
                disabled={!workspace.canCreate}
                onClick={() => edit()}
              >
                Create a task
              </Button>
            </div>
          ) : view === 'list' ? (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Status</th>
                    <th>Owner</th>
                    <th>Priority</th>
                    <th>Target date</th>
                    <th>Context</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => (
                    <tr key={t.id}>
                      <td>
                        <button
                          className={styles.titleButton}
                          onClick={() => edit(t)}
                        >
                          {t.title || 'Untitled task'}
                        </button>
                        {!t.canEdit && (
                          <span className={styles.muted}> · read only</span>
                        )}
                      </td>
                      <td>{status(t)}</td>
                      <td>{owner(t)}</td>
                      <td>{t.priority}</td>
                      <td>{dateLabel(t.dueDate)}</td>
                      <td>
                        {t.linkedDocIds.length
                          ? `${t.linkedDocIds.length} linked document${t.linkedDocIds.length === 1 ? '' : 's'}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.board}>
              {statuses.map(s => (
                <section key={s} className={styles.column}>
                  <div className={styles.columnHead}>
                    <span className={styles.status}>
                      <span
                        className={styles.dot}
                        style={{ background: colors[s] }}
                      />
                      {labels[s]}
                    </span>
                    <span>{filtered.filter(t => t.status === s).length}</span>
                  </div>
                  {filtered
                    .filter(t => t.status === s)
                    .map(t => (
                      <button
                        key={t.id}
                        className={styles.card}
                        onClick={() => edit(t)}
                      >
                        <p className={styles.cardTitle}>{t.title}</p>
                        <div className={styles.cardMeta}>
                          <span>{t.priority}</span>
                          <span>{dateLabel(t.dueDate)}</span>
                        </div>
                        <div className={styles.muted}>
                          {t.assigneeId ? 'Assigned' : 'Unassigned'} ·{' '}
                          {t.linkedDocIds.length} links
                        </div>
                      </button>
                    ))}
                </section>
              ))}
            </div>
          )}
        </div>
      </ViewBody>
      <Modal
        open={open}
        onOpenChange={value => {
          if (!value) close();
        }}
        contentOptions={{
          style: {
            width: 'calc(100vw - 40px)',
            maxWidth: 640,
            maxHeight: '90vh',
            overflow: 'auto',
          },
        }}
      >
        {selected && !current ? (
          <div role="alert" className={styles.alert}>
            {workspace.loading
              ? 'Checking task access…'
              : 'This task is no longer available in your accessible documents.'}
            <Button variant="plain" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        ) : (
          <>
            <h2>{selected ? 'Task details' : 'New task'}</h2>
            <div className={styles.form}>
              <label className={styles.field}>
                Title
                <input
                  autoFocus
                  className={styles.control}
                  value={draft.title}
                  maxLength={200}
                  required
                  disabled={!editable || busy}
                  onChange={e => set('title', e.target.value)}
                  placeholder="What needs to happen?"
                />
              </label>
              <div className={styles.grid}>
                <label className={styles.field}>
                  Status
                  <select
                    className={styles.control}
                    value={draft.status}
                    disabled={!editable || busy}
                    onChange={e => set('status', e.target.value as TaskStatus)}
                  >
                    {statuses.map(s => (
                      <option key={s} value={s}>
                        {labels[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className={styles.field}>
                  Owner · reassign to delegate
                  {workspace.isLocal ? (
                    <span className={styles.muted}>
                      Unassigned in local preview
                    </span>
                  ) : (
                    <MemberSelectorInline
                      selected={draft.assigneeId ? [draft.assigneeId] : []}
                      onChange={ids => set('assigneeId', ids.at(-1) || null)}
                      readonly={!editable || busy}
                      placeholder="Unassigned"
                    />
                  )}
                </div>
                <label className={styles.field}>
                  Priority
                  <select
                    className={styles.control}
                    value={draft.priority}
                    disabled={!editable || busy}
                    onChange={e =>
                      set('priority', e.target.value as TaskPriority)
                    }
                  >
                    {priorities.map(p => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  Target date · optional
                  <input
                    className={styles.control}
                    type="date"
                    value={draft.dueDate || ''}
                    disabled={!editable || busy}
                    onChange={e => set('dueDate', e.target.value || null)}
                  />
                </label>
              </div>
              {draft.status === 'blocked' && (
                <label className={styles.field}>
                  What’s blocking this?
                  <textarea
                    className={styles.control}
                    required
                    value={draft.blockedReason}
                    disabled={!editable || busy}
                    maxLength={2000}
                    rows={3}
                    onChange={e => set('blockedReason', e.target.value)}
                  />
                </label>
              )}
              <div className={styles.editorNote}>
                Description, checklist steps, files, and discussion use this
                task’s ordinary AFFiNE document.{' '}
                {selected
                  ? 'Open the document to work on the details.'
                  : 'Create the task, then open its document to add details.'}
              </div>
              {current?.legacyLinksDetected && (
                <div className={styles.alert} role="alert">
                  This task contains links from an earlier implementation. Its
                  document content or sync history may still contain those
                  references. New context links are disabled. Ask a workspace
                  owner to review its access and create a fresh task before
                  sharing more widely; existing data is not removed
                  automatically.
                  {editable && (
                    <Button
                      variant="plain"
                      disabled={busy}
                      onClick={() => setConfirmCleanup(true)}
                    >
                      Remove legacy links
                    </Button>
                  )}
                </div>
              )}
              {editable && !current?.legacyLinksDetected && (
                <div className={styles.field}>
                  Link a context document · optional
                  <span className={styles.muted}>
                    Linking requires edit access to both this task and the
                    context document. Read-only documents cannot be linked.
                    Context links appear in Related tasks; they are not graph
                    edges.
                  </span>
                  <input
                    className={styles.control}
                    placeholder="Find a document…"
                    aria-label="Find context document"
                    value={documentSearch}
                    onChange={e => setDocumentSearch(e.target.value)}
                  />
                  <select
                    className={styles.control}
                    aria-label="Context document"
                    value={sourceId}
                    disabled={busy}
                    onChange={e => setSourceId(e.target.value)}
                  >
                    <option value="">Choose a document</option>
                    {sourceDocs
                      .filter(d => !current?.linkedDocIds.includes(d.id))
                      .map(d => (
                        <option
                          key={d.id}
                          value={d.id}
                          disabled={!('canEdit' in d && d.canEdit === true)}
                        >
                          {d.title || 'Untitled'}
                          {!('canEdit' in d && d.canEdit === true)
                            ? ' · read only'
                            : ''}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              {formError && (
                <div role="alert" className={styles.alert}>
                  {formError} Your draft remains open.
                </div>
              )}
              <div className={styles.actions}>
                <div className={styles.actionGroup}>
                  {editable && (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void save()}
                    >
                      {busy
                        ? 'Saving…'
                        : selected
                          ? 'Save changes'
                          : 'Create task'}
                    </Button>
                  )}
                  <Button variant="plain" disabled={busy} onClick={close}>
                    Close
                  </Button>
                </div>
                {selected && (
                  <div className={styles.actionGroup}>
                    <Button
                      disabled={busy}
                      onClick={() => openDoc(selected.id)}
                    >
                      Open document
                    </Button>
                    {editable && (
                      <Button
                        variant="plain"
                        disabled={busy}
                        onClick={() => void archive()}
                      >
                        {selected.archived ? 'Restore' : 'Archive'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
            {current && (
              <>
                <section className={styles.section}>
                  <h3 className={styles.sectionHeading}>Linked context</h3>
                  {current.linkedDocIds.length ? (
                    current.linkedDocIds.map(id => {
                      const doc = workspace.readableDocs.find(d => d.id === id);
                      return doc ? (
                        <div key={id} className={styles.linked}>
                          <span>{doc.title || 'Untitled'}</span>
                          <Button variant="plain" onClick={() => openDoc(id)}>
                            Open
                          </Button>
                        </div>
                      ) : null;
                    })
                  ) : (
                    <p className={styles.muted}>No context linked yet.</p>
                  )}
                </section>
                <section className={styles.section}>
                  <h3 className={styles.sectionHeading}>Task activity</h3>
                  <ol className={styles.activity}>
                    {current.history.map(event => (
                      <li key={event.id}>
                        {event.body}
                        {event.actorId && !workspace.isLocal && (
                          <MemberSelectorInline
                            selected={[event.actorId]}
                            readonly
                            onChange={() => {}}
                            placeholder="Workspace member"
                          />
                        )}
                        <br />
                        <span className={styles.muted}>
                          {new Date(event.at).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            )}
          </>
        )}
      </Modal>
      <ConfirmModal
        open={confirmCleanup}
        onOpenChange={setConfirmCleanup}
        title="Remove legacy links?"
        description="This keeps task text and unrelated links. Old sync history and backups may retain removed references."
        confirmText="Remove links"
        cancelText="Keep links"
        autoFocusConfirm={false}
        confirmButtonOptions={{ variant: 'error', disabled: busy }}
        onCancel={() => setConfirmCleanup(false)}
        onConfirm={async () => {
          setConfirmCleanup(false);
          await removeLegacyLinks();
        }}
      />
    </>
  );
};
