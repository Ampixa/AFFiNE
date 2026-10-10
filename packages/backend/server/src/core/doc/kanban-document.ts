import { createHash } from 'node:crypto';

import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import z from 'zod/v3';

export class KanbanError extends Error {}

const id = z.string().min(1).max(128);
const viewSchema = z.object({
  id,
  name: z.string(),
  mode: z.literal('kanban'),
  groupBy: z.object({ columnId: id, name: z.literal('select') }),
  filter: z.object({ conditions: z.array(z.unknown()) }).optional(),
  header: z.object({ titleColumn: z.string().optional() }).optional(),
  groupProperties: z
    .array(z.object({ key: z.string(), hide: z.boolean().optional() }))
    .optional(),
});
const columnsSchema = z.array(
  z.object({
    id,
    type: z.string(),
    name: z.string(),
    data: z.unknown(),
  })
);
const optionsSchema = z.object({
  options: z
    .array(z.object({ id, value: z.string(), color: z.string().optional() }))
    .max(200),
});

function map(value: unknown): Y.Map<unknown> {
  if (!(value instanceof Y.Map))
    throw new KanbanError('UNSUPPORTED_BOARD: Expected a database map.');
  return value;
}
function array(value: unknown): Y.Array<unknown> {
  if (!(value instanceof Y.Array))
    throw new KanbanError('UNSUPPORTED_BOARD: Expected a database array.');
  return value;
}
function json(value: unknown): unknown {
  return value instanceof Y.Map || value instanceof Y.Array
    ? value.toJSON()
    : value;
}
function text(value: unknown): string {
  return value instanceof Y.Text ? value.toString() : '';
}

/** Operates on the same nested Yjs data used by DatabaseBlockSchema (version 3). */
export class KanbanDocument {
  private readonly blocks: Y.Map<unknown>;

  constructor(private readonly doc: Y.Doc) {
    this.blocks = doc.getMap('blocks');
  }

  private board(blockId: string, viewId: string) {
    const block = map(this.blocks.get(blockId));
    if (
      block.get('sys:flavour') !== 'affine:database' ||
      block.get('sys:version') !== 3
    ) {
      throw new KanbanError(
        'UNSUPPORTED_BOARD: Only version 3 database Kanban boards are supported.'
      );
    }
    const views = array(block.get('prop:views')).toArray();
    const candidate = views.find(
      v => (json(v) as { id?: string })?.id === viewId
    );
    const parsed = viewSchema.safeParse(json(candidate));
    if (!parsed.success)
      throw new KanbanError(
        'UNSUPPORTED_BOARD: Select a Kanban view grouped by a single-select property.'
      );
    const view = parsed.data;
    const parsedColumns = columnsSchema.safeParse(
      json(block.get('prop:columns'))
    );
    if (!parsedColumns.success)
      throw new KanbanError('UNSUPPORTED_BOARD: Invalid database properties.');
    const column = parsedColumns.data.find(c => c.id === view.groupBy.columnId);
    const parsedOptions = optionsSchema.safeParse(column?.data);
    if (column?.type !== 'select' || !parsedOptions.success) {
      throw new KanbanError(
        'UNSUPPORTED_BOARD: The grouping property must be single-select.'
      );
    }
    const options = parsedOptions.data.options;
    if (new Set(options.map(o => o.id)).size !== options.length) {
      throw new KanbanError('UNSUPPORTED_BOARD: Duplicate status IDs.');
    }
    const children = array(block.get('sys:children'));
    const rows = z.array(id).safeParse(children.toArray());
    if (!rows.success || new Set(rows.data).size !== rows.data.length) {
      throw new KanbanError('UNSUPPORTED_BOARD: Invalid database rows.');
    }
    return {
      block,
      view,
      column,
      options,
      children,
      rows: rows.data,
      cells: map(block.get('prop:cells')),
      titleColumn: parsedColumns.data.find(
        c => c.id === view.header?.titleColumn
      ),
    };
  }

  listBoards() {
    const boards: {
      blockId: string;
      viewId: string;
      title: string;
      name: string;
      supported: boolean;
      reason?: string;
    }[] = [];
    for (const [blockId, value] of this.blocks) {
      if (
        !(value instanceof Y.Map) ||
        value.get('sys:flavour') !== 'affine:database'
      )
        continue;
      const views = value.get('prop:views');
      if (!(views instanceof Y.Array)) continue;
      for (const raw of views.toArray()) {
        const view = json(raw) as {
          id?: string;
          name?: string;
          mode?: string;
        } | null;
        if (view?.mode !== 'kanban' || typeof view.id !== 'string') continue;
        let reason: string | undefined;
        try {
          this.board(blockId, view.id);
        } catch (error) {
          if (!(error instanceof KanbanError)) throw error;
          reason = error.message;
        }
        boards.push({
          blockId,
          viewId: view.id,
          title: text(value.get('prop:title')).slice(0, 1000),
          name: String(view.name ?? '').slice(0, 1000),
          supported: !reason,
          ...(reason ? { reason } : {}),
        });
        if (boards.length === 100) return { boards, truncated: true };
      }
    }
    return { boards, truncated: false };
  }

  private task(board: ReturnType<KanbanDocument['board']>, taskId: string) {
    if (!board.rows.includes(taskId))
      throw new KanbanError(
        'TASK_NOT_FOUND: Task does not belong to this board.'
      );
    const block = map(this.blocks.get(taskId));
    if (
      !['affine:paragraph', 'affine:list'].includes(
        String(block.get('sys:flavour'))
      )
    ) {
      throw new KanbanError(
        'UNSUPPORTED_TASK: Expected a paragraph or list card.'
      );
    }
    const row = board.cells.get(taskId);
    const cell = row === undefined ? undefined : map(row).get(board.column.id);
    const value = cell === undefined ? null : (map(cell).get('value') ?? null);
    if (value !== null && typeof value !== 'string')
      throw new KanbanError('UNSUPPORTED_TASK: Invalid status value.');
    return {
      taskId,
      title: text(block.get('prop:text')).slice(0, 4000),
      columnId: value as string | null,
    };
  }

  readBoard(blockId: string, viewId: string, offset = 0, limit = 50) {
    const board = this.board(blockId, viewId);
    const hidden = new Set(
      board.view.groupProperties?.filter(g => g.hide).map(g => g.key)
    );
    return {
      blockId,
      viewId,
      title: text(board.block.get('prop:title')).slice(0, 1000),
      name: board.view.name,
      statusPropertyId: board.column.id,
      columns: [
        { columnId: null, name: 'Ungrouped', hidden: hidden.has('Ungroups') },
        ...board.options.map(o => ({
          columnId: o.id,
          name: o.value,
          hidden: hidden.has(o.id),
        })),
      ],
      scope: 'all_database_rows',
      filtersApplied: false,
      hasViewFilter: !!board.view.filter?.conditions.length,
      tasks: board.rows
        .slice(offset, offset + limit)
        .map(taskId => this.task(board, taskId)),
      total: board.rows.length,
      nextOffset: offset + limit < board.rows.length ? offset + limit : null,
    };
  }

  private writableBoard(
    blockId: string,
    viewId: string,
    columnId: string | null
  ) {
    const board = this.board(blockId, viewId);
    if (board.view.filter?.conditions.length) {
      throw new KanbanError(
        'FILTERED_BOARD: Use an unfiltered Kanban view so changed tasks remain visible.'
      );
    }
    if (
      board.view.header?.titleColumn &&
      board.view.header.titleColumn !== 'title' &&
      board.titleColumn?.type !== 'title'
    ) {
      throw new KanbanError(
        'UNSUPPORTED_BOARD: The card heading must use the title property.'
      );
    }
    if (columnId !== null && !board.options.some(o => o.id === columnId)) {
      throw new KanbanError(
        'COLUMN_NOT_FOUND: Read the board and use a returned columnId, or null for Ungrouped.'
      );
    }
    const key = columnId ?? 'Ungroups';
    if (board.view.groupProperties?.some(g => g.key === key && g.hide)) {
      throw new KanbanError(
        'HIDDEN_COLUMN: Unhide the destination column before moving or creating tasks.'
      );
    }
    return board;
  }

  private setStatus(
    board: ReturnType<KanbanDocument['board']>,
    taskId: string,
    columnId: string | null
  ) {
    let row = board.cells.get(taskId);
    if (row === undefined) {
      row = new Y.Map();
      board.cells.set(taskId, row);
    }
    const rowMap = map(row);
    let cell = rowMap.get(board.column.id);
    if (cell === undefined) {
      cell = new Y.Map([['columnId', board.column.id]]);
      rowMap.set(board.column.id, cell);
    }
    map(cell).set('value', columnId);
  }

  createTask(
    blockId: string,
    viewId: string,
    title: string,
    columnId: string | null,
    requestId: string,
    editorId: string
  ) {
    const board = this.writableBoard(blockId, viewId, columnId);
    const requests = this.doc.getMap<{
      taskId: string;
      title: string;
      columnId: string | null;
      viewId: string;
    }>('mcp:kanbanRequests');
    const key = createHash('sha256')
      .update(JSON.stringify([blockId, requestId]))
      .digest('hex');
    const previous = requests.get(key);
    if (previous) {
      if (
        previous.title !== title ||
        previous.columnId !== columnId ||
        previous.viewId !== viewId
      ) {
        throw new KanbanError(
          'REQUEST_ID_CONFLICT: Reuse requestId only to retry the same creation.'
        );
      }
      return { ...this.task(board, previous.taskId), created: false };
    }
    const taskId = nanoid();
    const now = Date.now();
    this.doc.transact(() => {
      const task = new Y.Map<unknown>([
        ['sys:id', taskId],
        ['sys:flavour', 'affine:paragraph'],
        ['sys:version', 1],
        ['sys:children', new Y.Array()],
        ['prop:type', 'text'],
        ['prop:text', new Y.Text(title)],
        ['prop:collapsed', false],
        ['prop:meta:createdAt', now],
        ['prop:meta:updatedAt', now],
        ['prop:meta:createdBy', editorId],
        ['prop:meta:updatedBy', editorId],
      ]);
      this.blocks.set(taskId, task);
      board.children.push([taskId]);
      this.setStatus(board, taskId, columnId);
      requests.set(key, { taskId, title, columnId, viewId });
    });
    return { taskId, title, columnId, created: true };
  }

  moveTask(
    blockId: string,
    viewId: string,
    taskId: string,
    columnId: string | null,
    editorId: string
  ) {
    const board = this.writableBoard(blockId, viewId, columnId);
    const task = this.task(board, taskId);
    if (task.columnId === columnId) return { ...task, moved: false };
    this.doc.transact(() => {
      this.setStatus(board, taskId, columnId);
      const block = map(this.blocks.get(taskId));
      block.set('prop:meta:updatedAt', Date.now());
      block.set('prop:meta:updatedBy', editorId);
    });
    return { ...task, previousColumnId: task.columnId, columnId, moved: true };
  }
}
