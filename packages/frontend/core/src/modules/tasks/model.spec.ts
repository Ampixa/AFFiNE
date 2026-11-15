import { describe, expect, it } from 'vitest';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';

import {
  readTask,
  TASK_HISTORY_MAP,
  TASK_LINKS_MAP,
  TASK_MAP,
  validateTaskPatch,
} from './model';

describe('native task records', () => {
  it('requires a blocker and valid dates without imposing dates on every task', () => {
    expect(
      validateTaskPatch({ title: ' Optional date ', dueDate: null })
    ).toEqual({ title: 'Optional date', dueDate: null });
    expect(() => validateTaskPatch({ status: 'blocked' })).toThrow('blocking');
    expect(() => validateTaskPatch({ dueDate: '2026-02-30' })).toThrow(
      'valid target date'
    );
    expect(
      validateTaskPatch({
        status: 'blocked',
        blockedReason: ' Waiting for review ',
      })
    ).toEqual({ status: 'blocked', blockedReason: 'Waiting for review' });
  });
  it('does not classify arbitrary documents as tasks', () => {
    const doc = new Doc();
    expect(
      readTask(
        'doc',
        'Notes',
        doc.getMap(TASK_MAP),
        doc.getMap(TASK_LINKS_MAP),
        doc.getMap(TASK_HISTORY_MAP),
        false
      )
    ).toBeNull();
    doc.destroy();
  });
  it('merges independent field changes, links and unique history events across replicas', () => {
    const a = new Doc(),
      b = new Doc();
    a.getMap(TASK_MAP).set('schemaVersion', 1);
    applyUpdate(b, encodeStateAsUpdate(a));
    a.getMap(TASK_MAP).set('status', 'doing');
    b.getMap(TASK_MAP).set('priority', 'high');
    a.getMap(TASK_LINKS_MAP).set('source-a', true);
    b.getMap(TASK_LINKS_MAP).set('source-b', true);
    a.getMap(TASK_HISTORY_MAP).set('event-a', {
      actorId: 'a',
      at: 1,
      body: 'Status changed',
    });
    b.getMap(TASK_HISTORY_MAP).set('event-b', {
      actorId: 'b',
      at: 2,
      body: 'Priority changed',
    });
    applyUpdate(a, encodeStateAsUpdate(b));
    applyUpdate(b, encodeStateAsUpdate(a));
    const task = readTask(
      'doc',
      'Task',
      a.getMap(TASK_MAP),
      a.getMap(TASK_LINKS_MAP),
      a.getMap(TASK_HISTORY_MAP),
      true
    )!;
    expect(task.status).toBe('doing');
    expect(task.priority).toBe('high');
    expect(task.linkedDocIds).toEqual([]);
    expect(task.legacyLinksDetected).toBe(true);
    expect(task.history.map(event => event.id)).toEqual(['event-b', 'event-a']);
    expect(
      readTask(
        'doc',
        'Task',
        b.getMap(TASK_MAP),
        b.getMap(TASK_LINKS_MAP),
        b.getMap(TASK_HISTORY_MAP),
        true
      )
    ).toEqual(task);
    a.destroy();
    b.destroy();
  });
});
