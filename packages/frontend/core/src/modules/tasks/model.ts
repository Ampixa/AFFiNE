import type { Map as YMap } from 'yjs';

export const TASK_STATUSES = [
  'inbox',
  'ready',
  'doing',
  'blocked',
  'review',
  'done',
  'parked',
] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export interface TaskEvent {
  id: string;
  actorId: string | null;
  at: number;
  body: string;
}
export interface TaskComment {
  id: string;
  actorId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  edited: boolean;
  canEdit: boolean;
}
export interface Task {
  id: string;
  title: string;
  description?: string;
  detailDocId?: string | null;
  status: TaskStatus;
  assigneeId: string | null;
  priority: TaskPriority;
  dueDate: string | null;
  blockedReason: string;
  archived: boolean;
  linkedDocIds: string[];
  history: TaskEvent[];
  updatedAt: number;
  canEdit: boolean;
  canAdmin?: boolean;
  canLink?: boolean;
  canComment?: boolean;
  comments?: TaskComment[];
  commentsNextCursor?: number | null;
  legacyLinksDetected?: boolean;
}
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'status'
    | 'assigneeId'
    | 'priority'
    | 'dueDate'
    | 'blockedReason'
    | 'archived'
  >
>;
export type CreateTaskInput = TaskPatch & {
  title: string;
  linkedDocIds?: string[];
};
export const TASK_MAP = 'ampixa:task';
export const TASK_HISTORY_MAP = 'ampixa:task-history';
// Legacy task-owned links are not safe for mixed-permission documents.
export const TASK_LINKS_MAP = 'ampixa:task-links';
export const SOURCE_TASKS_MAP = 'ampixa:related-tasks';

export function validateTaskPatch(patch: TaskPatch, current?: Task): TaskPatch {
  const clean: TaskPatch = {};
  if (patch.title !== undefined) {
    if (
      typeof patch.title !== 'string' ||
      !patch.title.trim() ||
      patch.title.length > 200
    )
      throw new Error('Use a title between 1 and 200 characters.');
    clean.title = patch.title.trim();
  }
  if (patch.description !== undefined) {
    if (
      typeof patch.description !== 'string' ||
      patch.description.length > 20000
    )
      throw new Error('Keep the description under 20,000 characters.');
    clean.description = patch.description;
  }
  if (patch.status !== undefined) {
    if (!TASK_STATUSES.includes(patch.status))
      throw new Error('Choose a valid task status.');
    clean.status = patch.status;
  }
  if (patch.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(patch.priority))
      throw new Error('Choose a valid priority.');
    clean.priority = patch.priority;
  }
  if (patch.assigneeId !== undefined) {
    if (
      patch.assigneeId !== null &&
      (typeof patch.assigneeId !== 'string' ||
        !patch.assigneeId.trim() ||
        patch.assigneeId.length > 200)
    )
      throw new Error('Choose a workspace member.');
    clean.assigneeId = patch.assigneeId;
  }
  if (patch.dueDate !== undefined) {
    const d = patch.dueDate;
    if (
      d !== null &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !Number.isFinite(Date.parse(d)) ||
        new Date(d).toISOString().slice(0, 10) !== d)
    )
      throw new Error('Choose a valid target date.');
    clean.dueDate = d;
  }
  if (patch.blockedReason !== undefined) {
    if (
      typeof patch.blockedReason !== 'string' ||
      patch.blockedReason.length > 2000
    )
      throw new Error('Keep the blocker description under 2,000 characters.');
    clean.blockedReason = patch.blockedReason.trim();
  }
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean')
      throw new Error('Invalid archive value.');
    clean.archived = patch.archived;
  }
  if (
    (clean.status ?? current?.status) === 'blocked' &&
    !(clean.blockedReason ?? current?.blockedReason)?.trim()
  )
    throw new Error('Explain what is blocking this task.');
  return clean;
}

export function readTask(
  id: string,
  title: string,
  fields: YMap<unknown>,
  links: YMap<unknown>,
  history: YMap<unknown>,
  canEdit: boolean
): Task | null {
  if (fields.get('schemaVersion') !== 1) return null;
  const status = fields.get('status');
  const priority = fields.get('priority');
  const nullable = (key: string) =>
    typeof fields.get(key) === 'string' ? (fields.get(key) as string) : null;
  const events: TaskEvent[] = [];
  history.forEach((event, eventId) => {
    if (
      event &&
      typeof event === 'object' &&
      'at' in event &&
      typeof event.at === 'number' &&
      'body' in event &&
      typeof event.body === 'string'
    ) {
      events.push({
        id: eventId,
        at: event.at,
        body: event.body,
        actorId:
          'actorId' in event && typeof event.actorId === 'string'
            ? event.actorId
            : null,
      });
    }
  });
  return {
    id,
    title: title || 'Untitled task',
    status: TASK_STATUSES.includes(status as TaskStatus)
      ? (status as TaskStatus)
      : 'inbox',
    priority: TASK_PRIORITIES.includes(priority as TaskPriority)
      ? (priority as TaskPriority)
      : 'normal',
    assigneeId: nullable('assigneeId'),
    dueDate: nullable('dueDate'),
    blockedReason: nullable('blockedReason') ?? '',
    archived: fields.get('archived') === true,
    // Relations are derived from readable source documents by useTasks.
    linkedDocIds: [],
    legacyLinksDetected: links.size > 0,
    history: events.sort((a, b) => b.at - a.at),
    updatedAt:
      typeof fields.get('updatedAt') === 'number'
        ? (fields.get('updatedAt') as number)
        : 0,
    canEdit,
  };
}
