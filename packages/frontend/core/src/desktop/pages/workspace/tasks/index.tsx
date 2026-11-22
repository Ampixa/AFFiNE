import { Button, ConfirmModal, Modal } from '@affine/component';
import { MemberSelectorInline } from '@affine/core/components/member-selector';
import type {
  Task,
  TaskComment,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { TaskDependencies, taskInEpic } from './dependencies';
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
  | 'title'
  | 'description'
  | 'status'
  | 'assigneeId'
  | 'priority'
  | 'dueDate'
  | 'blockedReason'
  | 'kind'
  | 'parentId'
  | 'estimate'
  | 'doneWhen'
  | 'blockedByIds'
>;
const emptyDraft = (): Draft => ({
  title: '',
  description: '',
  status: 'inbox',
  assigneeId: null,
  priority: 'normal',
  dueDate: null,
  blockedReason: '',
  kind: 'task',
  parentId: null,
  estimate: '',
  doneWhen: '',
  blockedByIds: [],
});
const taskDraft = (task: Task): Draft => ({
  title: task.title,
  description: task.description ?? '',
  status: task.status,
  assigneeId: task.assigneeId,
  priority: task.priority,
  dueDate: task.dueDate,
  blockedReason: task.blockedReason,
  kind: task.kind ?? 'task',
  parentId: task.parentId ?? null,
  estimate: task.estimate ?? '',
  doneWhen: task.doneWhen ?? '',
  blockedByIds: task.blockedByIds ?? [],
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
  const [searchParams] = useSearchParams();
  const requestedTaskId = searchParams.get('task');
  const openedTaskId = useRef<string | null>(null);
  const workbench = useService(WorkbenchService).workbench;
  const [scope, setScope] = useState('all');
  const [view, setView] = useState<'list' | 'board' | 'dependencies'>('list');
  const [epicFilter, setEpicFilter] = useState('');
  const [blockerReview, setBlockerReview] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [initialDraft, setInitialDraft] = useState('');
  const [documentSearch, setDocumentSearch] = useState('');
  const tasksById = useMemo(
    () => new Map(workspace.tasks.map(task => [task.id, task])),
    [workspace.tasks]
  );

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
            (!epicFilter || taskInEpic(t, epicFilter, tasksById)) &&
            (!statusFilter || t.status === statusFilter) &&
            (!priorityFilter || t.priority === priorityFilter) &&
            (!ownerFilter.length || ownerFilter.includes(t.assigneeId || '')) &&
            (!query || t.title.toLowerCase().includes(query.toLowerCase()))
        )
        .sort(
          (a, b) =>
            (a.dueDate ?? '9999-12-31').localeCompare(
              b.dueDate ?? '9999-12-31'
            ) ||
            b.updatedAt - a.updatedAt ||
            a.id.localeCompare(b.id)
        ),
    [
      workspace.tasks,
      tasksById,
      workspace.currentUserId,
      scope,
      statusFilter,
      epicFilter,
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
  const sourceDocs = workspace.contextDocs.filter(
    d =>
      d.id !== selected?.id &&
      d.title.toLowerCase().includes(documentSearch.toLowerCase())
  );
  const { searchDocuments, loadTask } = workspace;
  const selectedId = selected?.id;
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void searchDocuments(documentSearch), 250);
    return () => clearTimeout(timer);
  }, [open, documentSearch, searchDocuments]);
  useEffect(() => {
    if (!open || !selectedId) return;
    void loadTask(selectedId).catch(() =>
      setFormError(
        'Could not refresh task details. Close and reopen to verify access.'
      )
    );
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden')
        void loadTask(selectedId).catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, [open, selectedId, loadTask]);
  const current = selected
    ? workspace.tasks.find(t => t.id === selected.id)
    : null;
  const dependencyReviewKey = JSON.stringify({
    task: selected?.id ?? null,
    revision: current?.updatedAt,
    status: draft.status,
    hidden: current?.hiddenBlockers,
    prerequisites: (draft.blockedByIds ?? []).map(id => [
      id,
      (tasksById.get(id) ?? current?.blockers?.find(t => t.id === id))
        ?.status ?? null,
    ]),
  });
  const editable = selected ? Boolean(current?.canEdit) : workspace.canCreate;
  const administrative = selected
    ? editable && Boolean(current?.canAdmin)
    : workspace.canAdmin;
  const canChangeArchive = Boolean(
    selected?.archived ? current?.canRestore : current?.canArchive
  );
  useEffect(() => {
    if (!open || !canChangeArchive) setArchiveOpen(false);
  }, [open, canChangeArchive]);
  useEffect(() => {
    if (!open || !editable || blockerReview !== dependencyReviewKey)
      setBlockerReview(null);
  }, [open, editable, blockerReview, dependencyReviewKey]);
  const canLink = selected
    ? editable && Boolean(current?.canLink)
    : workspace.canCreate;
  const [commentBody, setCommentBody] = useState('');
  const [editingComment, setEditingComment] = useState<TaskComment | null>(
    null
  );
  const [commentUncertain, setCommentUncertain] = useState(false);
  const [commentLoading, setCommentLoading] = useState(false);
  const loadEarlierComments = async () => {
    if (!current) return;

    if (current.commentsNextCursor == null) return;
    setCommentLoading(true);
    try {
      await workspace.loadMoreComments(current.id, current.commentsNextCursor);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Could not load more comments.'
      );
    } finally {
      setCommentLoading(false);
    }
  };
  const saveComment = async () => {
    if (!current?.canComment || busy || commentUncertain || !commentBody.trim())
      return;

    setBusy(true);
    setFormError('');
    try {
      await workspace.comment(
        current.id,
        commentBody,
        editingComment ?? undefined
      );
      setCommentBody('');
      setEditingComment(null);
    } catch (error) {
      setCommentUncertain(true);
      setFormError(
        (error instanceof Error
          ? error.message
          : 'Could not verify the comment outcome.') +
          ' Reopen the task and check the conversation before submitting again.'
      );
    } finally {
      setBusy(false);
    }
  };
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
    const d = task
      ? taskDraft(task)
      : {
          ...emptyDraft(),
          assigneeId: workspace.canAdmin ? null : workspace.currentUserId,
        };
    setSelected(task || null);
    setDraft(d);
    setInitialDraft(JSON.stringify(d));
    setSourceId('');
    setFormError('');
    setCommentBody('');
    setEditingComment(null);
    setCommentUncertain(false);
    setDocumentSearch('');
    setOpen(true);
  };
  useEffect(() => {
    if (
      !requestedTaskId ||
      openedTaskId.current === requestedTaskId ||
      workspace.loading
    )
      return;
    const task = workspace.tasks.find(value => value.id === requestedTaskId);
    if (!task) return;
    openedTaskId.current = requestedTaskId;
    const next = taskDraft(task);
    setSelected(task);
    setDraft(next);
    setInitialDraft(JSON.stringify(next));
    setSourceId('');
    setFormError('');
    setCommentBody('');
    setEditingComment(null);
    setCommentUncertain(false);
    setDocumentSearch('');
    setOpen(true);
  }, [requestedTaskId, workspace.loading, workspace.tasks]);
  const close = () => {
    if (busy) return;
    if (dirty || commentBody.trim()) {
      setDiscardOpen(true);
      return;
    }
    setOpen(false);
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(d => ({ ...d, [key]: value }));
  const save = async (acknowledgeOpenBlockers = false) => {
    if (!editable || busy) return;
    if (sourceId) {
      const source = workspace.readableDocs.find(doc => doc.id === sourceId);
      if (!canLink || !source) {
        setFormError('Choose a context document you can access.');
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
    if (
      !acknowledgeOpenBlockers &&
      ['doing', 'done'].includes(draft.status) &&
      draft.status !== selected?.status &&
      (current?.hiddenBlockers ||
        (draft.blockedByIds ?? []).some(id => {
          const task =
            tasksById.get(id) ?? current?.blockers?.find(t => t.id === id);
          return !task || task.status !== 'done';
        }))
    ) {
      setBlockerReview(dependencyReviewKey);
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      if (selected) {
        const patch: TaskPatch = {};
        for (const key of Object.keys(draft) as (keyof Draft)[])
          if (
            JSON.stringify(draft[key]) !==
            JSON.stringify(taskDraft(selected)[key])
          )
            Object.assign(patch, { [key]: draft[key] });
        if (acknowledgeOpenBlockers) patch.acknowledgeOpenBlockers = true;
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
          acknowledgeOpenBlockers,
          linkedDocIds: sourceId ? [sourceId] : [],
        });
      }
      setOpen(false);
      setNotice(selected ? 'Task updated.' : 'Task created.');
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
  const archive = async () => {
    if (!selected || !canChangeArchive || busy) return;
    setArchiveOpen(false);
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
          : 'Task archived. An admin can restore it from Archived.'
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
      {t.hasOpenBlockers && (
        <span
          title={(t.blockers ?? [])
            .filter(b => b.status !== 'done')
            .map(b => b.title)
            .join(', ')}
        >
          {' '}
          · Waiting on dependencies
        </span>
      )}
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
              Team tasks require a signed-in workspace. Existing local task
              documents are unchanged and remain available in All docs.
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
            <select
              className={styles.control}
              aria-label="Filter epic"
              value={epicFilter}
              onChange={event => setEpicFilter(event.target.value)}
            >
              <option value="">All epics</option>
              {workspace.tasks
                .filter(t => t.kind === 'epic' && !t.archived)
                .map(t => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
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
                setEpicFilter('');
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
            <Button
              variant="plain"
              className={view === 'dependencies' ? styles.active : undefined}
              onClick={() => setView('dependencies')}
            >
              Dependencies
            </Button>
          </div>
          <div className={styles.summary}>
            <span>{filtered.length} tasks shown</span>
            <span>{counts.open} open</span>
            <span>{counts.blocked} blocked</span>
            <span>{counts.review} ready for review</span>
          </div>
          {workspace.loading && (
            <p className={styles.muted} role="status">
              Loading tasks…
            </p>
          )}
          {!filtered.length ? (
            workspace.loading ? null : (
              <div className={styles.empty}>
                <h3>
                  {workspace.tasks.length
                    ? 'No tasks match this view.'
                    : 'Start with one small next step.'}
                </h3>
                <p>
                  Create a task, choose an owner, and link supporting documents
                  when you need them.
                </p>
                <Button
                  variant="primary"
                  disabled={!workspace.canCreate}
                  onClick={() => edit()}
                >
                  Create a task
                </Button>
              </div>
            )
          ) : view === 'dependencies' ? (
            <TaskDependencies tasks={filtered} onOpen={edit} />
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
                        <span className={styles.muted}>
                          {' '}
                          · {t.kind ?? 'task'}
                          {t.progress?.total
                            ? ` · ${t.progress.done}/${t.progress.total} done`
                            : ''}
                        </span>
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
                        <div className={styles.muted}>
                          {t.kind ?? 'task'}
                          {t.progress?.total
                            ? ` · ${t.progress.done}/${t.progress.total} done`
                            : ''}
                          {t.hasOpenBlockers
                            ? ' · Waiting on dependencies'
                            : ''}
                        </div>
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
              : 'This task is no longer available to you.'}
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
                  disabled={!(selected ? administrative : editable) || busy}
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
                      readonly={!administrative || busy}
                      placeholder="Unassigned"
                    />
                  )}
                </div>
                <label className={styles.field}>
                  Priority
                  <select
                    className={styles.control}
                    value={draft.priority}
                    disabled={!administrative || busy}
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
                    disabled={!administrative || busy}
                    onChange={e => set('dueDate', e.target.value || null)}
                  />
                </label>
              </div>
              <div className={styles.grid}>
                <label className={styles.field}>
                  Type
                  <select
                    className={styles.control}
                    value={draft.kind ?? 'task'}
                    disabled={!editable || busy}
                    onChange={event => {
                      set('kind', event.target.value as Task['kind']);
                      set('parentId', null);
                    }}
                  >
                    <option value="task">Task</option>
                    <option value="epic">Epic / workstream</option>
                    <option value="subtask">Subtask</option>
                  </select>
                </label>
                {draft.kind !== 'epic' && (
                  <label className={styles.field}>
                    {draft.kind === 'subtask'
                      ? 'Parent task'
                      : 'Epic · optional'}
                    <select
                      className={styles.control}
                      value={draft.parentId ?? ''}
                      disabled={!editable || busy}
                      onChange={event =>
                        set('parentId', event.target.value || null)
                      }
                    >
                      <option value="">
                        {current?.parentUnavailable
                          ? 'Parent unavailable'
                          : 'No parent'}
                      </option>
                      {workspace.tasks
                        .filter(
                          task =>
                            task.id !== selected?.id &&
                            (!task.archived || task.id === draft.parentId) &&
                            task.kind ===
                              (draft.kind === 'subtask' ? 'task' : 'epic')
                        )
                        .map(task => (
                          <option key={task.id} value={task.id}>
                            {task.title}
                            {task.archived ? ' · Archived' : ''}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label className={styles.field}>
                  Estimate · optional
                  <input
                    className={styles.control}
                    value={draft.estimate ?? ''}
                    maxLength={100}
                    disabled={!editable || busy}
                    onChange={event => set('estimate', event.target.value)}
                    placeholder="For example, two afternoons"
                  />
                </label>
              </div>
              <label className={styles.field}>
                Done when · optional
                <textarea
                  className={styles.control}
                  value={draft.doneWhen ?? ''}
                  maxLength={2000}
                  rows={2}
                  disabled={!editable || busy}
                  onChange={event => set('doneWhen', event.target.value)}
                  placeholder="What outcome will tell us this is finished?"
                />
              </label>
              <label className={styles.field}>
                Blocked by · optional
                <select
                  multiple
                  className={styles.control}
                  value={draft.blockedByIds ?? []}
                  disabled={!editable || busy || current?.hiddenBlockers}
                  onChange={event =>
                    set(
                      'blockedByIds',
                      Array.from(
                        event.target.selectedOptions,
                        option => option.value
                      )
                    )
                  }
                  size={Math.min(5, Math.max(2, workspace.tasks.length))}
                >
                  {workspace.tasks
                    .filter(
                      task =>
                        task.id !== selected?.id &&
                        (!task.archived ||
                          draft.blockedByIds?.includes(task.id))
                    )
                    .map(task => (
                      <option key={task.id} value={task.id}>
                        {task.title} · {task.archived ? 'Archived · ' : ''}
                        {labels[task.status]}
                      </option>
                    ))}
                </select>
                <span className={styles.muted}>
                  Select prerequisites. Hold Command or Control to select more
                  than one. Their completion updates this task’s dependency
                  badge.
                </span>
                {current?.hiddenBlockers && (
                  <span>
                    Some dependencies are unavailable. Ask an admin with access
                    to update them.
                  </span>
                )}
              </label>
              {current?.structureIncomplete && (
                <p role="status">
                  Some connections exceed the display limit. Narrow the
                  workstream; completion totals are unavailable.
                </p>
              )}
              {!!current?.blocks?.length && (
                <div className={styles.field}>
                  This task blocks
                  {current.blocks.map(task => (
                    <button
                      key={task.id}
                      className={styles.titleButton}
                      disabled={dirty || busy || Boolean(commentBody.trim())}
                      onClick={() => {
                        const target = workspace.tasks.find(
                          t => t.id === task.id
                        );
                        if (target) edit(target);
                      }}
                    >
                      {task.title}
                    </button>
                  ))}
                </div>
              )}
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
              <label className={styles.field}>
                Description
                <textarea
                  className={styles.control}
                  value={draft.description ?? ''}
                  disabled={!editable || busy}
                  maxLength={20000}
                  rows={5}
                  placeholder="Describe the work or next steps. Add - [ ] before a line for a checklist item."
                  onChange={e => set('description', e.target.value)}
                />
              </label>
              {(draft.description ?? '')
                .split('\n')
                .some(line => /^\s*- \[[ xX]\] /.test(line)) && (
                <fieldset className={styles.field} disabled={!editable || busy}>
                  <legend>Checklist</legend>
                  {(draft.description ?? '').split('\n').map((line, index) => {
                    const item = /^(\s*- \[)([ xX])(\] )(.*)$/.exec(line);
                    if (!item) return null;
                    return (
                      <label key={index}>
                        <input
                          type="checkbox"
                          checked={item[2].toLowerCase() === 'x'}
                          onChange={event => {
                            const lines = (draft.description ?? '').split('\n');
                            lines[index] =
                              item[1] +
                              (event.target.checked ? 'x' : ' ') +
                              item[3] +
                              item[4];
                            set('description', lines.join('\n'));
                          }}
                        />{' '}
                        {item[4]}
                      </label>
                    );
                  })}
                </fieldset>
              )}
              {canLink && (
                <div className={styles.field}>
                  Link a context document · optional
                  <span className={styles.muted}>
                    Linked documents keep their own access permissions. Linking
                    does not grant anyone access to a private document.
                  </span>
                  <input
                    className={styles.control}
                    placeholder="Type at least two characters…"
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
                        <option key={d.id} value={d.id}>
                          {d.title || 'Untitled'}
                        </option>
                      ))}
                  </select>
                  {workspace.contextLoading && (
                    <span role="status">Searching documents…</span>
                  )}
                  {workspace.hasMoreContext && (
                    <Button
                      variant="plain"
                      disabled={workspace.contextLoading}
                      onClick={() => void workspace.loadMoreDocuments()}
                    >
                      Load more documents
                    </Button>
                  )}
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
                    {current?.detailDocId && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          current.detailDocId && openDoc(current.detailDocId)
                        }
                      >
                        Open original document
                      </Button>
                    )}
                    {canChangeArchive && (
                      <Button
                        variant="plain"
                        disabled={busy}
                        onClick={() => setArchiveOpen(true)}
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
                  <h3 className={styles.sectionHeading}>Conversation</h3>
                  <p className={styles.muted}>
                    Comments are visible to people who can access this task.
                    Links do not grant document access.
                  </p>
                  <ol className={styles.activity}>
                    {[...(current.comments ?? [])]
                      .sort(
                        (a, b) =>
                          a.createdAt - b.createdAt || a.id.localeCompare(b.id)
                      )
                      .map(comment => (
                        <li key={comment.id}>
                          <MemberSelectorInline
                            selected={[comment.actorId]}
                            readonly
                            onChange={() => {}}
                            placeholder="Workspace member"
                          />
                          <span className={styles.muted}>
                            {new Date(comment.createdAt).toLocaleString()}
                            {comment.edited ? ' · edited' : ''}
                          </span>
                          <p
                            style={{
                              whiteSpace: 'pre-wrap',
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {comment.body
                              .split(/(https?:\/\/[^\s<>]+)/g)
                              .map((part, index) =>
                                /^https?:\/\//.test(part) ? (
                                  <a
                                    key={index}
                                    href={part}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    referrerPolicy="no-referrer"
                                  >
                                    {part}
                                  </a>
                                ) : (
                                  part
                                )
                              )}
                          </p>
                          {comment.canEdit && (
                            <Button
                              variant="plain"
                              disabled={busy || commentUncertain}
                              onClick={() => {
                                setCommentBody(comment.body);
                                setEditingComment(comment);
                                setCommentUncertain(false);
                              }}
                            >
                              Edit comment
                            </Button>
                          )}
                        </li>
                      ))}
                  </ol>
                  {current.commentsNextCursor != null && (
                    <Button
                      variant="plain"
                      disabled={commentLoading}
                      onClick={() => void loadEarlierComments()}
                    >
                      {commentLoading
                        ? 'Loading comments…'
                        : 'Load earlier comments'}
                    </Button>
                  )}
                  {current.canComment && (
                    <>
                      <label className={styles.field}>
                        {editingComment ? 'Edit your comment' : 'Add a comment'}
                        <textarea
                          className={styles.control}
                          value={commentBody}
                          maxLength={10000}
                          rows={3}
                          disabled={busy || commentUncertain}
                          onChange={event => setCommentBody(event.target.value)}
                          placeholder="Share an update or paste a link…"
                        />
                      </label>
                      <Button
                        disabled={
                          busy || commentUncertain || !commentBody.trim()
                        }
                        onClick={() => void saveComment()}
                      >
                        {editingComment ? 'Save comment' : 'Post comment'}
                      </Button>
                      {editingComment && (
                        <Button
                          variant="plain"
                          onClick={() => {
                            setEditingComment(null);
                            setCommentBody('');
                          }}
                        >
                          Cancel edit
                        </Button>
                      )}
                    </>
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
        open={Boolean(
          open && editable && blockerReview === dependencyReviewKey
        )}
        title="Continue with open dependencies?"
        description="This task still depends on unfinished work. You can continue if this is intentional; the dependency warning stays visible until the prerequisites are done."
        confirmText="Continue anyway"
        cancelText="Review dependencies"
        onConfirm={async () => {
          if (blockerReview !== dependencyReviewKey) return;
          setBlockerReview(null);
          await save(true);
        }}
        onCancel={() => setBlockerReview(null)}
      />
      <ConfirmModal
        open={archiveOpen}
        title={selected?.archived ? 'Restore task?' : 'Archive task?'}
        description={
          (selected?.archived
            ? 'This returns the task to active views. Its documents, comments and history are kept.'
            : 'This removes the task from active views. Its documents, comments and history are kept. An admin can restore it from Archived.') +
          (dirty ? ' Unsaved edits will be discarded.' : '')
        }
        confirmText={selected?.archived ? 'Restore task' : 'Archive task'}
        cancelText="Cancel"
        onConfirm={() => void archive()}
        onCancel={() => setArchiveOpen(false)}
      />
      <ConfirmModal
        open={discardOpen}
        title="Discard unsaved changes?"
        description="Your unsaved task or comment draft will be discarded. Saved work is kept."
        confirmText="Discard draft"
        cancelText="Keep editing"
        onConfirm={() => {
          setDiscardOpen(false);
          setOpen(false);
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </>
  );
};
