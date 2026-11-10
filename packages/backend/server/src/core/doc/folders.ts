import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { generateKeyBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';

import { EventBus, Mutex } from '../../base';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';

// Mirrors the frontend ORM table `folders` (frontend/core/src/modules/db/schema/schema.ts):
// each row is a top-level Y.Map named by its id, soft-deleted via `$$DELETED`.
type FolderRow = {
  id: string;
  parentId?: string | null;
  type: string; // 'folder' | 'doc' | 'tag' | 'collection'
  data: string; // folder name, or the linked doc/tag/collection id
  index: string;
};

export type FolderInfo = {
  id: string;
  name: string;
  parentId: string | null;
  docIds: string[];
};

export class FolderError extends Error {}

export const foldersDocId = (workspaceId: string) =>
  `db$${workspaceId}$folders`;

export function readFolderRows(doc: Y.Doc): FolderRow[] {
  const rows: FolderRow[] = [];
  for (const key of doc.share.keys()) {
    const map = doc.getMap(key);
    if (map.size === 0 || map.get('$$DELETED') === true) continue;
    rows.push({ ...(map.toJSON() as FolderRow), id: key });
  }
  return rows;
}

export function listFolders(rows: FolderRow[]): FolderInfo[] {
  return rows
    .filter(row => row.type === 'folder')
    .map(folder => ({
      id: folder.id,
      name: folder.data,
      parentId: folder.parentId ?? null,
      docIds: rows
        .filter(row => row.type === 'doc' && row.parentId === folder.id)
        .map(row => row.data),
    }));
}

const POSTFIX_SIZE = 32;
const POSTFIX_CHARS =
  '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Same key format as @toeverything/infra generateFractionalIndexingKeyBetween(last, null),
// which the server cannot import; keeps the sidebar's ordering and later inserts valid.
export function indexAfter(last: string | null) {
  const subkey =
    last && last.length > POSTFIX_SIZE + 1
      ? last.slice(0, -(POSTFIX_SIZE + 1))
      : last;
  const postfix = Array.from(
    randomBytes(POSTFIX_SIZE),
    byte => POSTFIX_CHARS[byte % POSTFIX_CHARS.length]
  ).join('');
  return generateKeyBetween(subkey || null, null) + '0' + postfix;
}

export function addDocLink(doc: Y.Doc, folderId: string, docId: string) {
  const rows = readFolderRows(doc);
  if (!rows.some(row => row.id === folderId && row.type === 'folder'))
    throw new FolderError(
      'FOLDER_NOT_FOUND: Use a folder id returned by list_folders.'
    );

  const siblings = rows.filter(row => row.parentId === folderId);
  const existing = siblings.find(
    row => row.type === 'doc' && row.data === docId
  );
  if (existing) return { linkId: existing.id, added: false };

  const last = siblings.reduce<string | null>(
    (max, row) => (max === null || row.index > max ? row.index : max),
    null
  );
  const id = nanoid();
  doc.transact(() => {
    const map = doc.getMap(id);
    map.set('id', id);
    map.set('parentId', folderId);
    map.set('type', 'doc');
    map.set('data', docId);
    map.set('index', indexAfter(last));
  });
  return { linkId: id, added: true };
}

@Injectable()
export class FolderService {
  constructor(
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly event: EventBus,
    private readonly mutex: Mutex
  ) {}

  async list(workspaceId: string, signal: AbortSignal) {
    return this.withDoc(workspaceId, signal, doc =>
      listFolders(readFolderRows(doc))
    );
  }

  async addDoc(
    workspaceId: string,
    folderId: string,
    docId: string,
    editor: string,
    signal: AbortSignal
  ) {
    // Serialize MCP writes so a retry cannot add the same doc twice.
    await using lock = await this.mutex.acquire(`mcp:folders:${workspaceId}`);
    if (!lock) throw new FolderError('FOLDERS_BUSY: Retry shortly.');
    return this.withDoc(
      workspaceId,
      signal,
      doc => addDocLink(doc, folderId, docId),
      editor
    );
  }

  private async withDoc<T>(
    workspaceId: string,
    signal: AbortSignal,
    action: (doc: Y.Doc) => T,
    editor?: string
  ): Promise<T> {
    signal.throwIfAborted();
    const docId = foldersDocId(workspaceId);
    const stored = await this.storage.getDoc(workspaceId, docId);
    signal.throwIfAborted();
    const doc = new Y.Doc();
    try {
      if (stored?.bin) Y.applyUpdate(doc, stored.bin);
      const updates: Uint8Array[] = [];
      doc.on('update', (update: Uint8Array) => updates.push(update));
      const result = action(doc);
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
          throw new FolderError(
            'WRITE_FAILED: The server did not accept the update. Retry.'
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
