import type { Task } from '@affine/core/modules/tasks/model';
import { useMemo } from 'react';

import * as styles from './index.css';

export function taskInEpic(task: Task, epicId: string, tasks: Task[]) {
  const byId = new Map(tasks.map(value => [value.id, value]));
  const seen = new Set<string>();
  let current: Task | undefined = task;
  while (current && !seen.has(current.id)) {
    if (current.id === epicId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

export function TaskDependencies({
  tasks,
  onOpen,
}: {
  tasks: Task[];
  onOpen: (task: Task) => void;
}) {
  const layout = useMemo(() => {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const level = new Map<string, number>();
    const incoming = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const task of tasks) {
      const ids = (task.blockedByIds ?? []).filter(id => byId.has(id));
      incoming.set(task.id, ids.length);
      for (const id of ids) {
        const list = children.get(id) ?? [];
        list.push(task.id);
        children.set(id, list);
      }
    }
    const queue = tasks
      .filter(task => !incoming.get(task.id))
      .map(task => task.id);
    for (const id of queue) {
      for (const child of children.get(id) ?? []) {
        level.set(
          child,
          Math.max(level.get(child) ?? 0, (level.get(id) ?? 0) + 1)
        );
        incoming.set(child, (incoming.get(child) ?? 1) - 1);
        if (!incoming.get(child)) queue.push(child);
      }
    }
    const counts = new Map<number, number>();
    const nodes = tasks.map(task => {
      const column = level.get(task.id) ?? 0,
        row = counts.get(column) ?? 0;
      counts.set(column, row + 1);
      return { task, x: column * 300 + 24, y: row * 120 + 24 };
    });
    return {
      nodes,
      width: Math.max(600, ...nodes.map(n => n.x + 280)),
      height: Math.max(160, ...nodes.map(n => n.y + 110)),
    };
  }, [tasks]);
  const nodes = new Map(layout.nodes.map(node => [node.task.id, node]));
  return (
    <div className={styles.dependencyScroll} aria-label="Task dependencies">
      <div
        style={{
          position: 'relative',
          width: layout.width,
          height: layout.height,
        }}
      >
        <svg
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
          className={styles.dependencyLines}
        >
          <defs>
            <marker
              id="task-dependency-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8" fill="currentColor" />
            </marker>
          </defs>
          {layout.nodes.flatMap(node =>
            (node.task.blockedByIds ?? []).map(id => {
              const from = nodes.get(id);
              if (!from) return null;
              return (
                <path
                  key={`${id}-${node.task.id}`}
                  d={`M${from.x + 244},${from.y + 42} C${from.x + 272},${from.y + 42} ${node.x - 28},${node.y + 42} ${node.x - 5},${node.y + 42}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  markerEnd="url(#task-dependency-arrow)"
                />
              );
            })
          )}
        </svg>
        {layout.nodes.map(({ task, x, y }) => (
          <button
            key={task.id}
            className={styles.dependencyNode}
            style={{ left: x, top: y }}
            onClick={() => onOpen(task)}
            title={task.title}
          >
            <span className={styles.muted}>
              {task.kind ?? 'task'} · {task.status}
            </span>
            <strong>{task.title}</strong>
            {task.hasOpenBlockers && <span>Waiting on dependencies</span>}
          </button>
        ))}
      </div>
      <p className={styles.muted}>
        Arrows point from a prerequisite to the work waiting on it. Select a
        task to open its details. Dependencies outside this filter remain in
        task details.
      </p>
    </div>
  );
}
