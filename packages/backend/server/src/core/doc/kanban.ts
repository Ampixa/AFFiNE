import { Injectable } from '@nestjs/common';
import * as Y from 'yjs';

import { EventBus, Mutex } from '../../base';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';
import { KanbanDocument, KanbanError } from './kanban-document';

@Injectable()
export class KanbanService {
  constructor(
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly event: EventBus,
    private readonly mutex: Mutex
  ) {}

  async read<T>(
    workspaceId: string,
    docId: string,
    signal: AbortSignal,
    read: (board: KanbanDocument) => T
  ): Promise<T> {
    return this.withDoc(workspaceId, docId, signal, read);
  }

  async write<T>(
    workspaceId: string,
    docId: string,
    editor: string,
    signal: AbortSignal,
    change: (board: KanbanDocument) => T
  ): Promise<T> {
    // Serialize MCP writes across server instances, including create retries.
    // Browser edits still merge using the normal Yjs conflict semantics.
    await using lock = await this.mutex.acquire(
      `mcp:kanban:${workspaceId}:${docId}`
    );
    if (!lock)
      throw new KanbanError(
        'BOARD_BUSY: Retry shortly with the same requestId.'
      );
    return await this.withDoc(workspaceId, docId, signal, change, editor);
  }

  private async withDoc<T>(
    workspaceId: string,
    docId: string,
    signal: AbortSignal,
    action: (board: KanbanDocument) => T,
    editor?: string
  ): Promise<T> {
    signal.throwIfAborted();
    const stored = await this.storage.getDoc(workspaceId, docId);
    signal.throwIfAborted();
    if (!stored?.bin)
      throw new KanbanError('DOCUMENT_NOT_FOUND: Document is unavailable.');
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, stored.bin);
      const updates: Uint8Array[] = [];
      doc.on('update', (update: Uint8Array) => updates.push(update));
      const result = action(new KanbanDocument(doc));
      signal.throwIfAborted();
      if (editor && updates.length) {
        const delta = Y.mergeUpdates(updates);
        const timestamp = await this.storage.pushDocUpdates(
          workspaceId,
          docId,
          [delta],
          editor
        );
        if (!timestamp)
          throw new KanbanError(
            'WRITE_FAILED: The server did not accept the update. Retry with the same requestId.'
          );
        this.event.emit('doc.updates.pushed', {
          spaceType: 'workspace',
          spaceId: workspaceId,
          docId,
          updates: [delta],
          timestamp,
          editor,
        });
      }
      return result;
    } finally {
      doc.destroy();
    }
  }
}
