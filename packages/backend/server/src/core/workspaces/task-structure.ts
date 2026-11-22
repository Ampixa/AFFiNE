import { BadRequest } from '../../base';

export type StructuredTask = {
  id: string;
  title: string;
  status: string;
  archived: boolean;
  kind: string;
  parentId: string | null;
  legacyDocId: string | null;
  blockedBy: { blockerId: string }[];
};

export function validateTaskStructure(
  rows: StructuredTask[],
  next: Pick<StructuredTask, 'id' | 'kind' | 'parentId' | 'status'>,
  blockers: string[]
) {
  const tasks = new Map(rows.map(row => [row.id, row]));
  const existing = tasks.get(next.id);
  const previousBlockers = new Set(
    existing?.blockedBy.map(edge => edge.blockerId)
  );
  if (next.parentId) {
    const parent = tasks.get(next.parentId);
    if (
      !parent ||
      (parent.archived && existing?.parentId !== parent.id) ||
      parent.id === next.id
    )
      throw new BadRequest(
        'Choose an available parent task in this workspace.'
      );
    if (
      (next.kind === 'task' && parent.kind !== 'epic') ||
      (next.kind === 'subtask' && parent.kind !== 'task') ||
      next.kind === 'epic'
    )
      throw new BadRequest('Epics contain tasks; tasks contain subtasks.');
    const seen = new Set([next.id]);
    let cursor: StructuredTask | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.id))
        throw new BadRequest('Task hierarchy cannot contain a cycle.');
      seen.add(cursor.id);
      cursor = cursor.parentId ? tasks.get(cursor.parentId) : undefined;
    }
  } else if (next.kind === 'subtask')
    throw new BadRequest('Choose a parent task for a subtask.');
  for (const child of rows.filter(row => row.parentId === next.id)) {
    if (
      (child.kind === 'task' && next.kind !== 'epic') ||
      (child.kind === 'subtask' && next.kind !== 'task')
    )
      throw new BadRequest('Move child tasks before changing this task type.');
  }
  const visited = new Set<string>();
  const pending = [...blockers];
  for (const id of blockers) {
    const blocker = tasks.get(id);
    if (!blocker || (blocker.archived && !previousBlockers.has(id)))
      throw new BadRequest('Choose available blocker tasks in this workspace.');
  }
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined) break;
    if (id === next.id)
      throw new BadRequest('Task dependencies cannot contain a cycle.');
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of tasks.get(id)?.blockedBy ?? [])
      pending.push(edge.blockerId);
  }
}

export function summarizeTaskStructure(
  rows: StructuredTask[],
  visibleIds: ReadonlySet<string>
) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const visible = rows.filter(row => visibleIds.has(row.id));
  const children = new Map<string, StructuredTask[]>();
  const dependents = new Map<string, StructuredTask[]>();
  for (const row of visible) {
    if (row.parentId && !row.archived) {
      const siblings = children.get(row.parentId) ?? [];
      siblings.push(row);
      children.set(row.parentId, siblings);
    }
    for (const edge of row.blockedBy) {
      const linked = dependents.get(edge.blockerId) ?? [];
      linked.push(row);
      dependents.set(edge.blockerId, linked);
    }
  }
  const compact = (task: StructuredTask) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    archived: task.archived,
  });
  return new Map(
    visible.map(row => {
      const allBlockers = row.blockedBy.map(edge => byId.get(edge.blockerId));
      const blockers = allBlockers.filter(
        (task): task is StructuredTask => !!task && visibleIds.has(task.id)
      );
      const childTasks = children.get(row.id) ?? [];
      return [
        row.id,
        {
          parentId:
            row.parentId && visibleIds.has(row.parentId) ? row.parentId : null,
          parentUnavailable: !!row.parentId && !visibleIds.has(row.parentId),
          blockedByIds: blockers.map(task => task.id),
          blockers: blockers.map(compact),
          blocks: (dependents.get(row.id) ?? []).map(compact),
          // Archiving an unfinished prerequisite must not silently complete it.
          // Inaccessible prerequisites reveal only a generic warning, never status.
          hasOpenBlockers: allBlockers.some(
            task => !task || !visibleIds.has(task.id) || task.status !== 'done'
          ),
          hiddenBlockers: allBlockers.some(
            task => !task || !visibleIds.has(task.id)
          ),
          progress: {
            done: childTasks.filter(task => task.status === 'done').length,
            total: childTasks.length,
          },
        },
      ];
    })
  );
}
