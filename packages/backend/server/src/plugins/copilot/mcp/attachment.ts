import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import * as Y from 'yjs';

import { Cache, EventBus, URLHelper } from '../../../base';
import { PgWorkspaceDocStorageAdapter } from '../../../core/doc';
import { PermissionAccess } from '../../../core/permission';
import { QuotaService } from '../../../core/quota';
import { WorkspaceBlobStorage } from '../../../core/storage';
import {
  MCP_ATTACHMENT_PREFIX,
  mcpAttachmentDocId,
} from '../../../core/storage/mcp-attachment';
import {
  type AttachmentInput,
  attachmentSizeLimit,
  AttachmentUploadError,
  decodeAttachment,
} from './attachment-input';

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

// Only insert into visible document notes or their paragraph/list children.
// Do not insert into database rows, the root metadata doc, or orphan blocks.
export function attachmentParent(doc: Y.Doc, afterBlockId?: string) {
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const page = [...blocks.values()].find(
    b => b instanceof Y.Map && b.get('sys:flavour') === 'affine:page'
  );
  const roots = page?.get('sys:children');
  if (!(roots instanceof Y.Array))
    throw new AttachmentUploadError(
      'INVALID_DOCUMENT: A page with a note is required.'
    );
  const notes = roots
    .toArray()
    .map(id => blocks.get(id))
    .filter(
      b =>
        b instanceof Y.Map &&
        b.get('sys:flavour') === 'affine:note' &&
        b.get('prop:displayMode') !== 'edgeless'
    );
  const visited = new Set<Y.Map<unknown>>();
  const find = (
    block: Y.Map<unknown>
  ): { children: Y.Array<string>; index: number } | undefined => {
    if (visited.has(block)) return;
    visited.add(block);
    const children = block.get('sys:children');
    if (!(children instanceof Y.Array)) return;
    const ids = children.toArray();
    if (afterBlockId && ids.includes(afterBlockId))
      return { children, index: ids.indexOf(afterBlockId) + 1 };
    for (const id of ids) {
      const child = blocks.get(id);
      if (
        child instanceof Y.Map &&
        ['affine:paragraph', 'affine:list'].includes(
          String(child.get('sys:flavour'))
        )
      ) {
        const found = find(child);
        if (found) return found;
      }
    }
    return;
  };
  if (afterBlockId) {
    for (const note of notes) {
      if (!note) continue;
      const found = find(note);
      if (found) return found;
    }
    throw new AttachmentUploadError(
      'INVALID_POSITION: afterBlockId must be a reachable block in a page note.'
    );
  }
  const children = notes.at(-1)?.get('sys:children');
  if (!(children instanceof Y.Array))
    throw new AttachmentUploadError(
      'INVALID_DOCUMENT: No page note accepts an attachment.'
    );
  return { children: children as Y.Array<string>, index: children.length };
}

@Injectable()
export class McpAttachmentService {
  private readonly logger = new Logger(McpAttachmentService.name);

  constructor(
    private readonly ac: PermissionAccess,
    private readonly docs: PgWorkspaceDocStorageAdapter,
    private readonly blobs: WorkspaceBlobStorage,
    private readonly quota: QuotaService,
    private readonly cache: Cache,
    private readonly transactions: TransactionHost<TransactionalAdapterPrisma>,
    private readonly event: EventBus,
    private readonly url: URLHelper
  ) {}

  private async assertWrite(
    userId: string,
    workspaceId: string,
    docId: string
  ) {
    const workspace = this.ac.user(userId).workspace(workspaceId);
    if (
      workspaceId === docId ||
      docId.startsWith('db$') ||
      docId.startsWith('userdata$') ||
      !(await workspace.can('Workspace.Read')) ||
      !(await workspace.can('Workspace.Blobs.Write')) ||
      !(await workspace.doc(docId).can('Doc.Update'))
    ) {
      throw new AttachmentUploadError(
        'ACCESS_DENIED: Workspace membership and document edit permission are required.'
      );
    }
  }

  async upload(
    userId: string,
    workspaceId: string,
    credentialId: string,
    input: AttachmentInput,
    signal: AbortSignal
  ) {
    signal.throwIfAborted();
    await this.assertWrite(userId, workspaceId, input.docId);
    const bytes = decodeAttachment(input, attachmentSizeLimit());
    // All blob accounting and document writes use Models' TransactionHost.
    // The transaction-scoped lock cannot expire while a write can still commit.
    // A timed-out transaction cannot save a late upload into the document.
    const result = await this.transactions.withTransaction(
      { timeout: 120_000, maxWait: 5_000 },
      async () => {
        const [lock] = await this.transactions.tx.$queryRaw<
          { locked: boolean }[]
        >`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${`mcp:attachment:${workspaceId}`}, 0)) AS locked
        `;
        if (!lock?.locked)
          throw new AttachmentUploadError(
            'UPLOAD_BUSY: Retry with the same requestId.'
          );
        return this.uploadLocked(
          userId,
          workspaceId,
          credentialId,
          input,
          signal,
          bytes
        );
      }
    );
    // Emit only after the transaction (including the blob quota row) commits.
    if (result.event) {
      this.logger.log(
        JSON.stringify({
          event: 'mcp.attachment.uploaded',
          credentialId,
          userId,
          workspaceId,
          docId: input.docId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          size: result.receipt.size,
          sha256: result.receipt.sha256,
          blobKey: result.receipt.blobKey,
          blockId: result.receipt.blockId,
          time: new Date().toISOString(),
        })
      );
      this.event.emit('doc.updates.pushed', result.event);
    }
    return result.receipt;
  }

  private async uploadLocked(
    userId: string,
    workspaceId: string,
    credentialId: string,
    input: AttachmentInput,
    signal: AbortSignal,
    bytes: Buffer
  ) {
    const sha256 = hash(bytes);
    const requestHash = hash(
      JSON.stringify([workspaceId, input.docId, credentialId, input.requestId])
    );
    const blockId = `mcp-upload-${requestHash}`;
    const fingerprint = hash(
      JSON.stringify([
        sha256,
        input.fileName,
        input.mimeType,
        input.afterBlockId ?? null,
        input.caption ?? null,
      ])
    );
    // Unique immutable attempt keys make cleanup safe if an interrupted old
    // object upload finishes after its SQL transaction has already rolled back.
    const blobKey = `${MCP_ATTACHMENT_PREFIX}${Buffer.from(input.docId).toString('base64url')}.${hash(`${requestHash}:${fingerprint}:${randomUUID()}`)}`;
    const receiptFor = (sourceId: string) => ({
      blobKey: sourceId,
      blockId,
      sha256,
      size: bytes.length,
      downloadUrl: this.url.link(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/blobs/${sourceId}`
      ),
    });
    signal.throwIfAborted();
    const stored = await this.docs.getDocBinNative(workspaceId, input.docId);
    if (!stored)
      throw new AttachmentUploadError(
        'DOCUMENT_NOT_FOUND: Document is unavailable.'
      );
    const doc = new Y.Doc();
    let writeAttempted = false;
    let uploadAttempted = false;
    try {
      Y.applyUpdate(doc, stored);
      const blocks = doc.getMap<Y.Map<unknown>>('blocks');
      const existing = blocks.get(blockId);
      if (existing) {
        if (
          !(existing instanceof Y.Map) ||
          existing.get('prop:mcpUploadHash') !== fingerprint
        )
          throw new AttachmentUploadError(
            'REQUEST_CONFLICT: requestId was used with different arguments.'
          );
        const sourceId = existing.get('prop:sourceId');
        if (
          typeof sourceId !== 'string' ||
          mcpAttachmentDocId(sourceId) !== input.docId ||
          existing.get('sys:flavour') !== 'affine:attachment'
        )
          throw new AttachmentUploadError(
            'ATTACHMENT_MISMATCH: The saved attachment identity has changed.'
          );
        await this.verifyStoredFile(
          workspaceId,
          sourceId,
          bytes.length,
          sha256
        );
        return {
          receipt: { ...receiptFor(sourceId), alreadyUploaded: true },
          event: undefined,
        };
      }
      attachmentParent(doc, input.afterBlockId);
      const count = await this.cache.increaseWithTtl(
        `mcp:attachment:rate:${credentialId}`,
        60 * 60 * 1000
      );
      if (count <= 0)
        throw new AttachmentUploadError(
          'UPLOAD_UNAVAILABLE: Upload rate limiter is unavailable.'
        );
      if (count > 20)
        throw new AttachmentUploadError(
          'RATE_LIMITED: Maximum 20 upload attempts per hour per credential.'
        );
      const check = await this.quota.getWorkspaceQuotaCalculator(workspaceId);
      const exceeded = check(bytes.length);
      if (exceeded?.blobQuotaExceeded || exceeded?.storageQuotaExceeded)
        throw new AttachmentUploadError(
          'QUOTA_EXCEEDED: Workspace file or total storage quota would be exceeded.'
        );
      await this.assertWrite(userId, workspaceId, input.docId);
      signal.throwIfAborted();
      uploadAttempted = true;
      await this.blobs.put(workspaceId, blobKey, bytes, {
        contentType: input.mimeType,
      });
      await this.assertWrite(userId, workspaceId, input.docId);
      signal.throwIfAborted();
      // Storage may be slow: merge fresh collaborator edits before resolving
      // the destination again. A deleted note must not receive an orphan block.
      const latest = await this.docs.getDocBinNative(workspaceId, input.docId);
      if (!latest)
        throw new AttachmentUploadError(
          'DOCUMENT_NOT_FOUND: Document is unavailable.'
        );
      Y.applyUpdate(doc, latest);
      const { children, index } = attachmentParent(doc, input.afterBlockId);
      const updates: Uint8Array[] = [];
      doc.on('update', (update: Uint8Array) => updates.push(update));
      doc.transact(() => {
        const block = new Y.Map<unknown>();
        for (const [key, value] of Object.entries({
          'sys:id': blockId,
          'sys:flavour': 'affine:attachment',
          'sys:version': 1,
          'sys:children': new Y.Array(),
          'prop:name': input.fileName,
          'prop:size': bytes.length,
          'prop:type': input.mimeType,
          'prop:sourceId': blobKey,
          'prop:caption': input.caption ?? '',
          'prop:embed': false,
          'prop:style': 'horizontalThin',
          'prop:index': 'a0',
          'prop:xywh': '[0,0,0,0]',
          'prop:rotate': 0,
          'prop:lockedBySelf': false,
          'prop:mcpUploadHash': fingerprint,
        }))
          block.set(key, value);
        blocks.set(blockId, block);
        children.insert(index, [blockId]);
      });
      const delta = Y.mergeUpdates(updates);
      writeAttempted = true;
      const timestamp = await this.docs.pushDocUpdates(
        workspaceId,
        input.docId,
        [delta],
        userId
      );
      if (!timestamp)
        throw new AttachmentUploadError(
          'WRITE_UNCERTAIN: Check the document and retry with the same requestId.'
        );
      return {
        receipt: { ...receiptFor(blobKey), alreadyUploaded: false },
        event: {
          spaceType: 'workspace' as const,
          spaceId: workspaceId,
          docId: input.docId,
          updates: [delta],
          timestamp,
          editor: userId,
        },
      };
    } catch (error) {
      // A failed/ambiguous document write may already have persisted: retain
      // the blob so a retry cannot leave a saved attachment pointing at nothing.
      if (uploadAttempted && !writeAttempted) {
        await this.blobs.delete(workspaceId, blobKey, true).catch(() => {
          this.logger.warn(
            JSON.stringify({
              event: 'mcp.attachment.cleanup_failed',
              workspaceId,
              blobKey,
            })
          );
        });
      }
      throw error;
    } finally {
      doc.destroy();
    }
  }

  private async verifyStoredFile(
    workspaceId: string,
    blobKey: string,
    size: number,
    sha256: string
  ) {
    const { body, metadata } = await this.blobs.get(
      workspaceId,
      blobKey,
      false
    );
    if (!body)
      throw new AttachmentUploadError(
        'ATTACHMENT_MISSING: The saved file is unavailable. Do not create a duplicate.'
      );
    const digest = createHash('sha256');
    let received = 0;
    try {
      if (metadata && metadata.contentLength !== size)
        throw new AttachmentUploadError(
          'ATTACHMENT_MISMATCH: The saved file size has changed.'
        );
      for await (const chunk of body) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += part.length;
        if (received > size)
          throw new AttachmentUploadError(
            'ATTACHMENT_MISMATCH: The saved file size has changed.'
          );
        digest.update(part);
      }
      if (received !== size || digest.digest('hex') !== sha256)
        throw new AttachmentUploadError(
          'ATTACHMENT_MISMATCH: The saved file content has changed.'
        );
    } finally {
      body.destroy();
    }
  }
}
