import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { type Prisma, PrismaClient, type WorkspaceTask } from '@prisma/client';
import type { Request } from 'express';
import { applyUpdate, Array as YArray, Doc as YDoc, Map as YMap } from 'yjs';
import { z } from 'zod';

import {
  ActionForbidden,
  BadRequest,
  getRequestCookie,
  HttpRequestError,
  NotFound,
} from '../../base';
import { AuthService, CurrentUser } from '../auth';
import { PgWorkspaceDocStorageAdapter } from '../doc';
import { PermissionAccess } from '../permission';

const identifier = z.string().min(1).max(128);
const fields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000),
  status: z.enum([
    'inbox',
    'ready',
    'doing',
    'blocked',
    'review',
    'done',
    'parked',
  ]),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  archived: z.boolean(),
  assigneeId: identifier.nullable(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  blockedReason: z.string().max(2000),
});
export const createSchema = fields
  .omit({ archived: true })
  .partial()
  .extend({
    title: fields.shape.title,
    linkedDocIds: z.array(identifier).max(20).default([]),
  })
  .strict();
export const patchSchema = fields
  .partial()
  .extend({
    expectedUpdatedAt: z.number().int().nonnegative(),
  })
  .strict();

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequest('Invalid task fields.');
  return parsed.data;
}

function taskConflict(message: string) {
  // AFFiNE maps unrecognized Nest HttpExceptions to 500. Use its HTTP error
  // representation so optimistic-concurrency failures retain their 409 status.
  const error = new HttpRequestError({ message });
  error.status = 409;
  return error;
}

function page(cursor?: string, limit?: string, maximum = 200) {
  const offset = cursor ? Number(cursor) : 0;
  const take = limit ? Number(limit) : Math.min(100, maximum);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000 ||
    !Number.isInteger(take) ||
    take < 1 ||
    take > maximum
  )
    throw new BadRequest('Invalid pagination.');
  return { skip: offset, take };
}

@Injectable()
export class WorkspaceTasksService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ac: PermissionAccess,
    private readonly storage: PgWorkspaceDocStorageAdapter
  ) {}

  private async access(userId: string, workspaceId: string, write = false) {
    // Workspace.Read alone can include guests with access to a single document.
    // Independent tasks belong to active workspace members, not document guests.
    const member = await this.db.workspaceMember.findFirst({
      where: { workspaceId, userId, state: 'active' },
      select: { id: true },
    });
    if (!member) throw new ActionForbidden('Workspace membership required.');
    await this.ac
      .user(userId)
      .workspace(workspaceId)
      .assert(write ? 'Workspace.CreateDoc' : 'Workspace.Read');
  }

  async isAdmin(userId: string, workspaceId: string) {
    await this.access(userId, workspaceId);
    return this.ac
      .user(userId)
      .workspace(workspaceId)
      .can('Workspace.Users.Manage');
  }

  private assertMemberCreate(
    userId: string,
    value: {
      assigneeId?: string | null;
      priority?: string;
      dueDate?: string | null;
    }
  ) {
    if (
      (value.assigneeId !== undefined && value.assigneeId !== userId) ||
      (value.priority !== undefined && value.priority !== 'normal') ||
      (value.dueDate !== undefined && value.dueDate !== null)
    )
      throw new ActionForbidden(
        'Members may create only self-assigned tasks with default priority and no deadline.'
      );
  }

  private async assertLinkOwner(
    userId: string,
    workspaceId: string,
    assigneeId: string | null
  ) {
    const admin = await this.isAdmin(userId, workspaceId);
    if (!admin && assigneeId !== userId)
      throw new ActionForbidden(
        'Only the assigned member or a workspace admin may change task context links.'
      );
    return admin;
  }

  private async lockActor(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string
  ) {
    // Serialize a task write with membership removal/role changes. A revoked
    // membership cannot pass an earlier read and commit after its revocation.
    const members = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM workspace_members
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND state = 'active'
      FOR SHARE`;
    if (!members.length)
      throw new ActionForbidden('Workspace membership required.');
    await this.access(userId, workspaceId);
  }

  private docAllowed(
    userId: string,
    workspaceId: string,
    docId: string,
    write = false
  ) {
    return this.ac
      .user(userId)
      .doc(workspaceId, docId)
      .can(write ? 'Doc.Update' : 'Doc.Read');
  }

  private async existingDocumentIds(workspaceId: string, ids: string[]) {
    if (!ids.length) return new Set<string>();
    const where = { workspaceId, id: { in: [...new Set(ids)] } };
    // Permission defaults can authorize a missing document. Imported tasks must
    // fail closed once their ACL anchor is deleted. Select identifiers only.
    const [snapshots, updates] = await Promise.all([
      this.db.snapshot.findMany({ where, select: { id: true } }),
      this.db.update.findMany({
        where,
        select: { id: true },
        distinct: ['id'],
      }),
    ]);
    return new Set([...snapshots, ...updates].map(row => row.id));
  }

  private async task(
    userId: string,
    workspaceId: string,
    id: string,
    write = false
  ) {
    await this.access(userId, workspaceId, write);
    const task = await this.db.workspaceTask.findFirst({
      where: { id, workspaceId },
    });
    if (
      !task ||
      (task.legacyDocId &&
        (!(await this.existingDocumentIds(workspaceId, [task.legacyDocId])).has(
          task.legacyDocId
        ) ||
          !(await this.docAllowed(
            userId,
            workspaceId,
            task.legacyDocId,
            write
          ))))
    )
      throw new NotFound('Task unavailable.');
    return task;
  }

  private async assignee(
    workspaceId: string,
    userId: string | null | undefined,
    legacyDocId?: string | null
  ) {
    if (!userId) return;
    const member = await this.db.workspaceMember.findFirst({
      where: { workspaceId, userId, state: 'active' },
      select: { id: true },
    });
    if (
      !member ||
      (legacyDocId &&
        !(await this.docAllowed(userId, workspaceId, legacyDocId)))
    )
      throw new BadRequest('Choose an active member with task access.');
  }

  private validateState(value: {
    status: string;
    blockedReason: string;
    dueDate?: string | null;
  }) {
    if (value.status === 'blocked' && !value.blockedReason.trim())
      throw new BadRequest('Explain what is blocking this task.');
    if (
      value.dueDate &&
      (Number.isNaN(Date.parse(value.dueDate)) ||
        new Date(value.dueDate).toISOString().slice(0, 10) !== value.dueDate)
    )
      throw new BadRequest('Choose a valid target date.');
  }

  private async linkedDocs(userId: string, workspaceId: string, ids: string[]) {
    const docs = await this.db.workspaceDoc.findMany({
      where: { workspaceId, docId: { in: [...new Set(ids)] }, blocked: false },
      select: { docId: true, title: true },
    });
    const visible: { id: string; title: string; canEdit: boolean }[] = [];
    // ACL checks are bounded to actual links, never every workspace document.
    for (const doc of docs) {
      if (!(await this.docAllowed(userId, workspaceId, doc.docId))) continue;
      visible.push({
        id: doc.docId,
        title: doc.title || 'Untitled',
        canEdit: await this.docAllowed(userId, workspaceId, doc.docId, true),
      });
    }
    return visible;
  }

  private async serialize(
    userId: string,
    row: WorkspaceTask,
    linkedDocIds: string[],
    canWrite: boolean,
    detail = false,
    adminCapability?: boolean
  ) {
    const history = detail
      ? await this.db.taskActivity.findMany({
          where: { taskId: row.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        })
      : [];
    const admin =
      adminCapability ?? (await this.isAdmin(userId, row.workspaceId));
    const editable =
      canWrite &&
      (admin || row.assigneeId === userId) &&
      (!row.legacyDocId ||
        (await this.docAllowed(
          userId,
          row.workspaceId,
          row.legacyDocId,
          true
        )));
    return {
      canAdmin: admin,
      canLink: editable,
      canComment: true,
      comments: detail
        ? await this.comments(userId, row.workspaceId, row.id)
        : [],
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      archived: row.archived,
      assigneeId: row.assigneeId,
      dueDate: row.dueDate,
      blockedReason: row.blockedReason,
      updatedAt: row.updatedAt.getTime(),
      version: row.version,
      detailDocId: row.legacyDocId,
      linkedDocIds,
      canEdit: editable,
      history: history.map(e => ({
        id: e.id,
        actorId: e.actorId,
        body: e.body,
        at: e.createdAt.getTime(),
      })),
    };
  }

  async members(userId: string, workspaceId: string) {
    await this.access(userId, workspaceId);
    await this.ac
      .user(userId)
      .workspace(workspaceId)
      .assert('Workspace.Users.Read');
    return this.db.workspaceMember.findMany({
      where: { workspaceId, state: 'active' },
      select: { userId: true, user: { select: { name: true } } },
      take: 200,
    });
  }

  async list(
    userId: string,
    workspaceId: string,
    cursor?: string,
    limit?: string,
    docId?: string
  ) {
    await this.access(userId, workspaceId);
    if (docId && !(await this.docAllowed(userId, workspaceId, docId)))
      throw new NotFound('Document unavailable.');
    const paging = page(cursor, limit);
    const rows = await this.db.workspaceTask.findMany({
      where: { workspaceId, ...(docId ? { links: { some: { docId } } } : {}) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...paging,
      include: { links: true },
    });
    const anchors = await this.existingDocumentIds(
      workspaceId,
      rows.flatMap(row => (row.legacyDocId ? [row.legacyDocId] : []))
    );
    const readable = [];
    for (const row of rows) {
      if (
        !row.legacyDocId ||
        (anchors.has(row.legacyDocId) &&
          (await this.docAllowed(userId, workspaceId, row.legacyDocId)))
      )
        readable.push(row);
    }
    const linkedDocs = await this.linkedDocs(
      userId,
      workspaceId,
      readable.flatMap(t => t.links.map(l => l.docId))
    );
    const allowed = new Set(linkedDocs.map(d => d.id));
    const canAdmin = await this.ac
      .user(userId)
      .workspace(workspaceId)
      .can('Workspace.Users.Manage');
    const canWrite = await this.ac
      .user(userId)
      .workspace(workspaceId)
      .can('Workspace.CreateDoc');
    const tasks = [];
    for (const row of readable)
      tasks.push(
        await this.serialize(
          userId,
          row,
          row.links.map(l => l.docId).filter(id => allowed.has(id)),
          canWrite,
          false,
          canAdmin
        )
      );
    return {
      tasks,
      linkedDocs,
      canCreate: canWrite,
      canAdmin,
      nextCursor:
        rows.length === paging.take ? String(paging.skip + rows.length) : null,
    };
  }

  async get(userId: string, workspaceId: string, id: string) {
    const row = await this.task(userId, workspaceId, id);
    const links = await this.db.taskDocumentLink.findMany({
      where: { taskId: id },
    });
    const linked = await this.linkedDocs(
      userId,
      workspaceId,
      links.map(l => l.docId)
    );
    return this.serialize(
      userId,
      row,
      linked.map(d => d.id),
      await this.ac
        .user(userId)
        .workspace(workspaceId)
        .can('Workspace.CreateDoc'),
      true
    );
  }

  async context(
    userId: string,
    workspaceId: string,
    query = '',
    cursor?: string
  ) {
    await this.access(userId, workspaceId);
    if (query.length > 200) throw new BadRequest('Search is too long.');
    const paging = page(cursor, '50', 50);
    const activeIds = await this.activeDocumentIds(workspaceId);
    const rows = await this.db.workspaceDoc.findMany({
      where: {
        workspaceId,
        blocked: false,
        docId: { in: [...activeIds] },
        ...(query ? { title: { contains: query, mode: 'insensitive' } } : {}),
      },
      select: { docId: true },
      orderBy: { docId: 'asc' },
      ...paging,
    });
    return {
      docs: await this.linkedDocs(
        userId,
        workspaceId,
        rows.map(r => r.docId)
      ),
      nextCursor:
        rows.length === paging.take ? String(paging.skip + rows.length) : null,
    };
  }

  private async activeDocumentIds(workspaceId: string) {
    // Only the optional context picker/link action reads root metadata. Task
    // listing never opens or scans document snapshots.
    const binary = await this.storage.getDocBinNative(workspaceId, workspaceId);
    if (!binary) throw new NotFound('Document metadata unavailable.');
    const root = new YDoc();
    try {
      applyUpdate(root, binary);
      const pages = root.getMap('meta').get('pages');
      if (!(pages instanceof YArray)) return new Set<string>();
      return new Set(
        pages.toArray().flatMap(page => {
          if (!(page instanceof YMap) || Boolean(page.get('trash'))) return [];
          const id = page.get('id');
          return typeof id === 'string' ? [id] : [];
        })
      );
    } finally {
      root.destroy();
    }
  }

  private async assertLink(
    userId: string,
    workspaceId: string,
    docId: string,
    activeIds?: ReadonlySet<string>
  ) {
    if (!(activeIds ?? (await this.activeDocumentIds(workspaceId))).has(docId))
      throw new NotFound('Document unavailable.');
    const doc = await this.db.workspaceDoc.findUnique({
      where: { workspaceId_docId: { workspaceId, docId } },
      select: { blocked: true },
    });
    if (
      !doc ||
      doc.blocked ||
      !(await this.docAllowed(userId, workspaceId, docId))
    )
      throw new NotFound('Document unavailable.');
  }

  async prepareCreate(userId: string, workspaceId: string, input: unknown) {
    await this.access(userId, workspaceId, true);
    const admin = await this.isAdmin(userId, workspaceId);
    const parsed = parse(createSchema, input);
    if (!admin) this.assertMemberCreate(userId, parsed);
    const { linkedDocIds, ...value } = parsed;
    const data = {
      description: '',
      status: 'inbox',
      priority: 'normal',
      blockedReason: '',
      ...value,
      ...(!admin ? { assigneeId: userId } : {}),
    };
    this.validateState(data);
    await this.assignee(workspaceId, data.assigneeId);
    const ids = [...new Set(linkedDocIds)];
    const activeIds = ids.length
      ? await this.activeDocumentIds(workspaceId)
      : undefined;
    for (const id of ids)
      await this.assertLink(userId, workspaceId, id, activeIds);
    return { data, ids };
  }

  async create(userId: string, workspaceId: string, input: unknown) {
    const { data, ids } = await this.prepareCreate(userId, workspaceId, input);
    const row = await this.db.$transaction(async tx => {
      await this.lockActor(tx, userId, workspaceId);
      await this.access(userId, workspaceId, true);
      if (!(await this.isAdmin(userId, workspaceId)))
        this.assertMemberCreate(userId, {
          ...data,
          assigneeId: data.assigneeId ?? null,
        });
      await this.assignee(workspaceId, data.assigneeId);
      for (const id of ids) await this.assertLink(userId, workspaceId, id);
      return tx.workspaceTask.create({
        data: {
          ...data,
          workspaceId,
          createdBy: userId,
          updatedBy: userId,
          links: { create: ids.map(docId => ({ docId })) },
          activity: { create: { actorId: userId, body: 'Created task.' } },
        },
      });
    });
    return this.get(userId, workspaceId, row.id);
  }

  async update(
    userId: string,
    workspaceId: string,
    id: string,
    input: unknown,
    assignedOnly = false
  ) {
    const row = await this.task(userId, workspaceId, id, true);
    const { expectedUpdatedAt, ...patch } = parse(patchSchema, input);
    if (!Object.keys(patch).length)
      throw new BadRequest('No task changes provided.');
    const admin = await this.isAdmin(userId, workspaceId);
    if (assignedOnly && row.assigneeId !== userId)
      throw new ActionForbidden('Task ownership changed.');
    if (
      !admin &&
      (row.assigneeId !== userId ||
        Object.keys(patch).some(
          key => !['description', 'status', 'blockedReason'].includes(key)
        ))
    )
      throw new ActionForbidden(
        'Only the assigned owner can update task progress. Other fields require an admin.'
      );
    this.validateState({ ...row, ...patch });
    await this.assignee(workspaceId, patch.assigneeId, row.legacyDocId);
    await this.db.$transaction(async tx => {
      await this.lockActor(tx, userId, workspaceId);
      await this.task(userId, workspaceId, id, true);
      const currentAdmin = await this.isAdmin(userId, workspaceId);
      if (
        !currentAdmin &&
        Object.keys(patch).some(
          key => !['description', 'status', 'blockedReason'].includes(key)
        )
      )
        throw new ActionForbidden(
          'Task administration requires a workspace admin.'
        );
      const changed = await tx.workspaceTask.updateMany({
        where: {
          id,
          workspaceId,
          version: row.version,
          ...(!currentAdmin || assignedOnly ? { assigneeId: userId } : {}),
          updatedAt: new Date(expectedUpdatedAt),
        },
        data: {
          ...patch,
          updatedBy: userId,
          version: { increment: 1 },
          updatedAt: new Date(
            Math.max(Date.now(), row.updatedAt.getTime() + 1)
          ),
        },
      });
      if (changed.count !== 1)
        throw taskConflict('Task changed. Refresh before saving.');
      await tx.taskActivity.create({
        data: {
          taskId: id,
          actorId: userId,
          body: `Updated ${Object.keys(patch).sort().join(', ')}.`,
        },
      });
    });
    return this.get(userId, workspaceId, id);
  }

  async comments(
    userId: string,
    workspaceId: string,
    id: string,
    cursor?: string
  ) {
    await this.task(userId, workspaceId, id);
    const paging = page(cursor, '50', 50);
    const rows = await this.db.taskComment.findMany({
      where: { taskId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...paging,
    });
    return rows.map(row => ({
      ...row,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      canEdit: row.actorId === userId,
    }));
  }

  async comment(
    userId: string,
    workspaceId: string,
    id: string,
    input: unknown,
    commentId?: string
  ) {
    await this.task(userId, workspaceId, id);
    const value = parse(
      z
        .object({
          body: z.string().trim().min(1).max(10000),
          expectedUpdatedAt: z.number().int().optional(),
        })
        .strict(),
      input
    );
    return this.db.$transaction(async tx => {
      await this.lockActor(tx, userId, workspaceId);
      await this.task(userId, workspaceId, id);
      if (commentId) {
        if (value.expectedUpdatedAt === undefined)
          throw new BadRequest('Comment revision required.');
        const result = await tx.taskComment.updateMany({
          where: {
            id: commentId,
            taskId: id,
            actorId: userId,
            updatedAt: new Date(value.expectedUpdatedAt),
          },
          data: {
            body: value.body,
            updatedAt: new Date(
              Math.max(Date.now(), value.expectedUpdatedAt + 1)
            ),
            edited: true,
          },
        });
        if (result.count !== 1)
          throw taskConflict(
            'Comment changed or is not yours. Refresh before editing.'
          );
      } else {
        await tx.taskComment.create({
          data: { taskId: id, actorId: userId, body: value.body },
        });
      }
      await tx.taskActivity.create({
        data: {
          taskId: id,
          actorId: userId,
          body: commentId ? 'Edited a comment.' : 'Added a comment.',
        },
      });
      return { saved: true };
    });
  }

  async prepareLink(
    userId: string,
    workspaceId: string,
    id: string,
    docId: string
  ) {
    const row = await this.task(userId, workspaceId, id, true);
    await this.assertLinkOwner(userId, workspaceId, row.assigneeId);
    parse(identifier, docId);
    await this.assertLink(userId, workspaceId, docId);
    return this.get(userId, workspaceId, id);
  }

  async link(
    userId: string,
    workspaceId: string,
    id: string,
    docId: string,
    remove = false,
    expectedUpdatedAt?: number
  ) {
    const row = await this.task(userId, workspaceId, id, true);
    await this.assertLinkOwner(userId, workspaceId, row.assigneeId);
    if (
      expectedUpdatedAt !== undefined &&
      row.updatedAt.getTime() !== expectedUpdatedAt
    )
      throw taskConflict('Task changed. Review a fresh preview.');
    parse(identifier, docId);
    await this.assertLink(userId, workspaceId, docId);
    await this.db.$transaction(async tx => {
      await this.lockActor(tx, userId, workspaceId);
      const current = await this.task(userId, workspaceId, id, true);
      if (
        expectedUpdatedAt !== undefined &&
        current.updatedAt.getTime() !== expectedUpdatedAt
      )
        throw taskConflict('Task changed. Review a fresh preview.');
      const admin = await this.assertLinkOwner(
        userId,
        workspaceId,
        current.assigneeId
      );
      await this.assertLink(userId, workspaceId, docId);
      const existing = await tx.taskDocumentLink.findUnique({
        where: { taskId_docId: { taskId: id, docId } },
      });
      if (remove ? !existing : existing) return;
      const changed = await tx.workspaceTask.updateMany({
        where: {
          id,
          workspaceId,
          version: row.version,
          ...(!admin ? { assigneeId: userId } : {}),
        },
        data: {
          version: { increment: 1 },
          updatedBy: userId,
          updatedAt: new Date(
            Math.max(Date.now(), row.updatedAt.getTime() + 1)
          ),
        },
      });
      if (changed.count !== 1)
        throw taskConflict('Task changed. Refresh before linking.');
      if (remove)
        await tx.taskDocumentLink.deleteMany({ where: { taskId: id, docId } });
      else {
        if ((await tx.taskDocumentLink.count({ where: { taskId: id } })) >= 20)
          throw new BadRequest('A task can link up to 20 documents.');
        await tx.taskDocumentLink.upsert({
          where: { taskId_docId: { taskId: id, docId } },
          create: { taskId: id, docId },
          update: {},
        });
      }
      // Never retain document titles/IDs in activity: access can later be revoked.
      await tx.taskActivity.create({
        data: {
          taskId: id,
          actorId: userId,
          body: remove ? 'Removed context link.' : 'Linked context document.',
        },
      });
    });
    return this.get(userId, workspaceId, id);
  }
}

@Controller('/api/workspaces/:workspaceId/tasks')
export class WorkspaceTasksController {
  constructor(private readonly tasks: WorkspaceTasksService) {}

  private mutation(req: Request) {
    if (req.authType === 'jwt') return;
    const token = req.get('x-affine-csrf-token');
    if (!token || token !== getRequestCookie(req, AuthService.csrfCookieName))
      throw new ActionForbidden('CSRF verification failed.');
  }

  @Header('Cache-Control', 'private, no-store')
  @Get()
  list(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('docId') docId?: string
  ) {
    return this.tasks.list(user.id, ws, cursor, limit, docId);
  }
  @Header('Cache-Control', 'private, no-store')
  @Get('context-docs')
  context(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string
  ) {
    return this.tasks.context(user.id, ws, q, cursor);
  }
  @Header('Cache-Control', 'private, no-store')
  @Get(':id')
  get(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Param('id') id: string
  ) {
    return this.tasks.get(user.id, ws, id);
  }
  @Header('Cache-Control', 'private, no-store')
  @Post()
  create(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Req() req: Request,
    @Body() body: unknown
  ) {
    this.mutation(req);
    return this.tasks.create(user.id, ws, body);
  }
  @Header('Cache-Control', 'private, no-store')
  @Patch(':id')
  update(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: unknown
  ) {
    this.mutation(req);
    return this.tasks.update(user.id, ws, id, body);
  }

  @Header('Cache-Control', 'private, no-store')
  @Get(':id/comments')
  comments(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @Query('cursor') cursor?: string
  ) {
    return this.tasks.comments(user.id, ws, id, cursor);
  }
  @Post(':id/comments')
  comment(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: unknown
  ) {
    this.mutation(req);
    return this.tasks.comment(user.id, ws, id, body);
  }
  @Patch(':id/comments/:commentId')
  editComment(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Req() req: Request,
    @Body() body: unknown
  ) {
    this.mutation(req);
    return this.tasks.comment(user.id, ws, id, body, commentId);
  }
  @Header('Cache-Control', 'private, no-store')
  @Post(':id/links')
  link(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: unknown
  ) {
    this.mutation(req);
    return this.tasks.link(
      user.id,
      ws,
      id,
      parse(z.object({ docId: identifier }).strict(), body).docId
    );
  }
  @Header('Cache-Control', 'private, no-store')
  @Delete(':id/links/:docId')
  unlink(
    @CurrentUser() user: CurrentUser,
    @Param('workspaceId') ws: string,
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Req() req: Request
  ) {
    this.mutation(req);
    return this.tasks.link(user.id, ws, id, docId, true);
  }
}
