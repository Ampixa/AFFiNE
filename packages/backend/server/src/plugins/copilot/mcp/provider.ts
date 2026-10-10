import { Injectable } from '@nestjs/common';
import { McpAccessMode } from '@prisma/client';
import z from 'zod/v3';

import { DocReader, DocWriter, KanbanService } from '../../../core/doc';
import { KanbanError } from '../../../core/doc/kanban-document';
import { PermissionAccess } from '../../../core/permission';
import { DocumentRetrievalService } from '../retrieval/document';

type McpTextContent = {
  type: 'text';
  text: string;
};

export type WorkspaceMcpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

export type WorkspaceMcpServer = {
  name: string;
  version: string;
  tools: WorkspaceMcpToolDefinition[];
};

type ToolExecutorInput<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  parser: T;
  inputSchema: Record<string, unknown>;
  execute: (
    args: z.infer<T>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

function toolText(text: string): WorkspaceMcpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function toolError(message: string): WorkspaceMcpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function toInputError(error: z.ZodError) {
  const details = error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return toolError(`Invalid arguments: ${details || 'Invalid input'}`);
}

function abortIfNeeded(
  signal: AbortSignal
): WorkspaceMcpToolResult | undefined {
  if (signal.aborted) return toolError('Request aborted.');
  return;
}

function defineTool<T extends z.ZodTypeAny>(
  config: ToolExecutorInput<T>
): WorkspaceMcpToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (args, options) => {
      const aborted = abortIfNeeded(options.signal);
      if (aborted) return aborted;

      const parsed = config.parser.safeParse(args ?? {});
      if (!parsed.success) return toInputError(parsed.error);
      return await config.execute(parsed.data, options);
    },
  };
}

@Injectable()
export class WorkspaceMcpProvider {
  constructor(
    private readonly ac: PermissionAccess,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly retrieval: DocumentRetrievalService,
    private readonly kanban: KanbanService
  ) {}

  async for(
    userId: string,
    workspaceId: string,
    accessMode: McpAccessMode = McpAccessMode.READ_ONLY
  ): Promise<WorkspaceMcpServer> {
    await this.ac.user(userId).workspace(workspaceId).assert('Workspace.Read');

    const readDocument = defineTool({
      name: 'read_document',
      title: 'Read Document',
      description: 'Read a document with given ID',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible) return notFoundError;

        const abortedAfterPermission = abortIfNeeded(options.signal);
        if (abortedAfterPermission) return abortedAfterPermission;

        const content = await this.reader.getDocMarkdown(
          workspaceId,
          docId,
          false
        );
        if (!content) return notFoundError;

        const abortedAfterRead = abortIfNeeded(options.signal);
        if (abortedAfterRead) return abortedAfterRead;

        return toolText(content.markdown);
      },
    });

    const docSearch = defineTool({
      name: 'doc_search',
      title: 'Document Search',
      description:
        'Search persisted workspace documents and return bounded passages with Page or canvas locators. Retrieval strategy is selected by the server and never includes files, blobs, attachments, or the web.',
      parser: z.object({
        query: z.string().trim().min(1).max(2000),
        doc_ids: z.array(z.string().min(1).max(128)).max(50).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          doc_ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 50,
          },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, doc_ids, limit }, options) => {
        let result;
        try {
          result = await this.retrieval.search(
            { user: userId, workspace: workspaceId },
            query,
            doc_ids,
            limit ?? 10,
            options.signal
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === 'SEARCH_UNAVAILABLE'
          ) {
            return toolError(
              'SEARCH_UNAVAILABLE: Workspace search has no available search backend. ' +
                'Ask the server administrator to enable or restore the keyword indexer ' +
                'or embedding service. This is not an empty search result. ' +
                'Documents with known IDs can still be read with read_document.'
            );
          }
          throw error;
        }
        return toolText(
          JSON.stringify({
            retrieval_mode: result.retrievalMode,
            degraded_reason: result.degradedReason,
            coverage: result.coverage,
            hits: result.hits.map(hit => ({
              doc_id: hit.docId,
              title: hit.title,
              excerpt: hit.excerpt,
              visibility: hit.visibility,
              block_id: hit.blockId,
              element_id: hit.elementId,
              frame_id: hit.frameId,
            })),
          })
        );
      },
    });

    const kanbanId = z.string().min(1).max(128);
    const boardArgs = { docId: kanbanId, blockId: kanbanId, viewId: kanbanId };
    const boardProperties = {
      docId: { type: 'string', minLength: 1, maxLength: 128 },
      blockId: { type: 'string', minLength: 1, maxLength: 128 },
      viewId: { type: 'string', minLength: 1, maxLength: 128 },
    };
    const columnProperty = {
      type: ['string', 'null'],
      minLength: 1,
      maxLength: 128,
      description:
        'Status option ID returned by read_kanban_board; null means Ungrouped. Never pass a column name.',
    };
    const executeKanban = async <T extends object>(
      docId: string,
      write: boolean,
      signal: AbortSignal,
      action: () => Promise<T>
    ): Promise<WorkspaceMcpToolResult> => {
      if (
        write &&
        (accessMode !== McpAccessMode.READ_WRITE || !env.mcpWriteEnabled)
      ) {
        return toolError('Kanban writes are disabled.');
      }
      const accessible = await this.ac
        .user(userId)
        .workspace(workspaceId)
        .doc(docId)
        .can(write ? 'Doc.Update' : 'Doc.Read');
      if (!accessible) return toolError(`Doc with id ${docId} not found.`);
      const aborted = abortIfNeeded(signal);
      if (aborted) return aborted;
      try {
        const result = await action();
        return toolText(JSON.stringify({ docId, ...result }));
      } catch (error) {
        // Document contents and infrastructure errors must not leak through MCP.
        if (signal.aborted)
          return toolError(
            'Request aborted. Check the board before retrying a write.'
          );
        return toolError(
          error instanceof KanbanError
            ? error.message
            : 'KANBAN_UNAVAILABLE: The board could not be read or saved. Retry later; reuse requestId for create retries.'
        );
      }
    };
    const listKanbanBoards = defineTool({
      name: 'list_kanban_boards',
      title: 'List Kanban Boards',
      description:
        'Discover database Kanban views in a known document, including blockId/viewId and support status. Use doc_search or a document link to obtain docId first.',
      parser: z.object({ docId: kanbanId }).strict(),
      inputSchema: {
        type: 'object',
        properties: { docId: boardProperties.docId },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, { signal }) =>
        executeKanban(docId, false, signal, () =>
          this.kanban.read(workspaceId, docId, signal, board =>
            board.listBoards()
          )
        ),
    });
    const readKanbanBoard = defineTool({
      name: 'read_kanban_board',
      title: 'Read Kanban Board',
      description:
        'Read single-select Kanban columns and paginated tasks with stable IDs. Returns all database rows in source order, not the view filter or manual card order. Read before creating or moving tasks.',
      parser: z
        .object({
          ...boardArgs,
          offset: z.number().int().min(0).max(1000000).default(0),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict(),
      inputSchema: {
        type: 'object',
        properties: {
          ...boardProperties,
          offset: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
        required: ['docId', 'blockId', 'viewId'],
        additionalProperties: false,
      },
      execute: async ({ docId, blockId, viewId, offset, limit }, { signal }) =>
        executeKanban(docId, false, signal, () =>
          this.kanban.read(workspaceId, docId, signal, board =>
            board.readBoard(blockId, viewId, offset, limit)
          )
        ),
    });

    const tools = [readDocument, docSearch, listKanbanBoards, readKanbanBoard];

    if (accessMode === McpAccessMode.READ_WRITE && env.mcpWriteEnabled) {
      const createDocument = defineTool({
        name: 'create_document',
        title: 'Create Document',
        description:
          'Create a new document in the workspace with the given title and markdown content. Returns the ID of the created document. Does not insert databases or images. For tasks on an existing Kanban board, use create_kanban_task.',
        parser: z.object({
          title: z.string().min(1),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'The title of the new document',
            },
            content: {
              type: 'string',
              description: 'The markdown content for the document body',
            },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
        execute: async ({ title, content }, options) => {
          try {
            await this.ac
              .user(userId)
              .workspace(workspaceId)
              .assert('Workspace.CreateDoc');

            const abortedAfterPermission = abortIfNeeded(options.signal);
            if (abortedAfterPermission) return abortedAfterPermission;

            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');
            const strippedContent = content.replace(
              /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
              ''
            );
            const result = await this.writer.createDoc(
              workspaceId,
              sanitizedTitle,
              strippedContent,
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId: result.docId,
                message: `Document "${title}" created successfully`,
              })
            );
          } catch (error) {
            return toolError(
              `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocument = defineTool({
        name: 'update_document',
        title: 'Update Document',
        description:
          'Update an existing document with new markdown content (body only). Uses structural diffing to apply minimal changes, preserving document history and enabling real-time collaboration. This does NOT update the document title, databases, or images. Use create_kanban_task or move_kanban_task for Kanban cards.',
        parser: z.object({
          docId: z.string(),
          content: z.string(),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            content: {
              type: 'string',
              description:
                'The complete new markdown content for the document body (do NOT include a title H1)',
            },
          },
          required: ['docId', 'content'],
          additionalProperties: false,
        },
        execute: async ({ docId, content }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          const accessible = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!accessible) return notFoundError;

          const abortedBeforeWrite = abortIfNeeded(options.signal);
          if (abortedBeforeWrite) return abortedBeforeWrite;

          try {
            await this.writer.updateDoc(workspaceId, docId, content, userId);
            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document updated successfully',
              })
            );
          } catch (error) {
            return toolError(
              `Failed to update document: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const updateDocumentMeta = defineTool({
        name: 'update_document_meta',
        title: 'Update Document Metadata',
        description: 'Update document metadata (currently title only).',
        parser: z.object({
          docId: z.string(),
          title: z.string().min(1),
        }),
        inputSchema: {
          type: 'object',
          properties: {
            docId: {
              type: 'string',
              description: 'The ID of the document to update',
            },
            title: {
              type: 'string',
              description: 'The new document title',
            },
          },
          required: ['docId', 'title'],
          additionalProperties: false,
        },
        execute: async ({ docId, title }, options) => {
          const notFoundError = toolError(`Doc with id ${docId} not found.`);

          const accessible = await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .can('Doc.Update');
          if (!accessible) return notFoundError;

          const abortedAfterPermission = abortIfNeeded(options.signal);
          if (abortedAfterPermission) return abortedAfterPermission;

          try {
            const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
            if (!sanitizedTitle) throw new Error('Title cannot be empty');

            await this.writer.updateDocMeta(
              workspaceId,
              docId,
              { title: sanitizedTitle },
              userId
            );

            return toolText(
              JSON.stringify({
                success: true,
                docId,
                message: 'Document title updated successfully',
              })
            );
          } catch (error) {
            return toolError(
              `Failed to update document metadata: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        },
      });

      const createKanbanTask = defineTool({
        name: 'create_kanban_task',
        title: 'Create Kanban Task',
        description:
          'Create a plain-text card in an existing, unfiltered single-select Kanban view. Use columnId from read_kanban_board. Generate a requestId once and reuse it for retries to avoid duplicate tasks; use a new ID for each new task.',
        parser: z
          .object({
            ...boardArgs,
            title: z.string().trim().min(1).max(1000),
            columnId: kanbanId.nullable(),
            requestId: z
              .string()
              .min(8)
              .max(128)
              .regex(/^[a-zA-Z0-9_-]+$/),
          })
          .strict(),
        inputSchema: {
          type: 'object',
          properties: {
            ...boardProperties,
            title: { type: 'string', minLength: 1, maxLength: 1000 },
            columnId: columnProperty,
            requestId: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
              pattern: '^[a-zA-Z0-9_-]+$',
            },
          },
          required: [
            'docId',
            'blockId',
            'viewId',
            'title',
            'columnId',
            'requestId',
          ],
          additionalProperties: false,
        },
        execute: async (
          { docId, blockId, viewId, title, columnId, requestId },
          { signal }
        ) =>
          executeKanban(docId, true, signal, () =>
            this.kanban.write(workspaceId, docId, userId, signal, board =>
              board.createTask(
                blockId,
                viewId,
                title,
                columnId,
                requestId,
                userId
              )
            )
          ),
      });
      const moveKanbanTask = defineTool({
        name: 'move_kanban_task',
        title: 'Move Kanban Task',
        description:
          'Move an existing card to a returned columnId (or null for Ungrouped) in an unfiltered single-select Kanban view. Changes only its status and edit metadata; preserves title, other properties, and view ordering. Moving to its current column is a no-op.',
        parser: z
          .object({
            ...boardArgs,
            taskId: kanbanId,
            columnId: kanbanId.nullable(),
          })
          .strict(),
        inputSchema: {
          type: 'object',
          properties: {
            ...boardProperties,
            taskId: boardProperties.blockId,
            columnId: columnProperty,
          },
          required: ['docId', 'blockId', 'viewId', 'taskId', 'columnId'],
          additionalProperties: false,
        },
        execute: async (
          { docId, blockId, viewId, taskId, columnId },
          { signal }
        ) =>
          executeKanban(docId, true, signal, () =>
            this.kanban.write(workspaceId, docId, userId, signal, board =>
              board.moveTask(blockId, viewId, taskId, columnId, userId)
            )
          ),
      });
      tools.push(
        createDocument,
        updateDocument,
        updateDocumentMeta,
        createKanbanTask,
        moveKanbanTask
      );
    }

    return {
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.1.0',
      tools,
    };
  }
}
