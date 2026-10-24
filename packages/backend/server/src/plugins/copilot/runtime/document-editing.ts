import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import createHttpError from 'http-errors';
import * as Y from 'yjs';

import { Cache, Config, Mutex } from '../../../base';
import { DocReader, DocWriter } from '../../../core/doc';
import { documentRevision } from '../../../core/doc/writer';
import { PermissionAccess } from '../../../core/permission';
import { parseDocToMarkdownFromDocSnapshot } from '../../../core/utils/blocksuite';
import { Models } from '../../../models';
import type { CopilotChatOptions } from '../providers/types';
import {
  type DocumentEdit,
  DocumentEditSchema,
  type DocumentEditScope,
} from './document-edit-contract';

const TTL = 15 * 60 * 1000;
const MAX_TEXT_BYTES = 32 * 1024;
type Proposal = {
  userId: string;
  workspaceId: string;
  sessionId: string;
  edit: DocumentEdit;
  revision?: string;
  before: string;
  title: string;
  expiresAt: number;
};
type Receipt = { status: 'applied' | 'cancelled'; docId?: string };

// Markdown cannot round-trip canvas objects or arbitrary rich-text attributes.
// Refuse these sources rather than silently replacing them with a text projection.
export function assertMarkdownEditable(bin: Uint8Array) {
  const doc = new Y.Doc();
  const reject = () => {
    throw createHttpError(
      400,
      'This document contains formatting or canvas content that chat cannot safely edit. Use the document editor instead.'
    );
  };
  const check = (value: unknown): void => {
    if (value instanceof Y.Text) {
      for (const delta of value.toDelta()) {
        if (
          typeof delta.insert !== 'string' ||
          Object.keys(delta.attributes ?? {}).some(
            key => !['bold', 'italic', 'strike', 'code', 'link'].includes(key)
          )
        )
          reject();
      }
    } else if (value instanceof Y.Map) {
      value.forEach(check);
    } else if (value instanceof Y.Array) {
      value.forEach(check);
    }
  };
  try {
    Y.applyUpdate(doc, bin);
    for (const block of doc.getMap<Y.Map<unknown>>('blocks').values()) {
      if (!(block instanceof Y.Map)) reject();
      const flavour = block.get('sys:flavour');
      if (
        flavour === 'affine:note' &&
        block.get('prop:displayMode') === 'edgeless'
      )
        reject();
      const storedElements = block.get('prop:elements');
      const elements =
        storedElements instanceof Y.Map &&
        storedElements.get('type') === '$blocksuite:internal:native$'
          ? storedElements.get('value')
          : storedElements;
      if (
        elements instanceof Y.Map
          ? elements.size > 0
          : elements && Object.keys(elements).length > 0
      )
        reject();
      check(block);
    }
    // Older edgeless documents also store elements outside the blocks map.
    const surface = doc.share.get('surface');
    if (surface && JSON.stringify(surface.toJSON()) !== '{}') reject();
  } finally {
    doc.destroy();
  }
}

// Proposals are short-lived, bounded Redis entries, not another document store.
// A model can propose, but only an authenticated UI request can apply a proposal.
@Injectable()
export class DocumentEditing {
  constructor(
    private readonly config: Config,
    private readonly ac: PermissionAccess,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly models: Models,
    private readonly cache: Cache,
    private readonly mutex: Mutex
  ) {}

  private enabled() {
    if (!this.config.copilotSelfHosted.documentEditing) {
      throw createHttpError(
        403,
        'Document editing is disabled on this server.'
      );
    }
  }

  private async authorize(userId: string, workspaceId: string, docId?: string) {
    const workspace = await this.models.workspace.get(workspaceId);
    if (!workspace?.enableAi)
      throw createHttpError(403, 'Workspace AI is disabled.');
    const access = this.ac.user(userId).workspace(workspaceId);
    const allowed = docId
      ? (await access.doc(docId).can('Doc.Read')) &&
        (await access.doc(docId).can('Doc.Update'))
      : await access.can('Workspace.CreateDoc');
    if (!allowed)
      throw createHttpError(
        403,
        'You do not have permission for this document action.'
      );
  }

  async prepare(
    userId: string,
    workspaceId: string,
    selectedIds: readonly string[],
    writableIds: readonly string[] = [],
    allowCreate = false
  ): Promise<DocumentEditScope | undefined> {
    if (!writableIds.length && !allowCreate) return undefined;
    this.enabled();
    const ids = [...new Set(writableIds)];
    if (ids.length > 4 || ids.some(id => !selectedIds.includes(id))) {
      throw createHttpError(
        400,
        'Select up to four documents and explicitly allow editing each one.'
      );
    }
    if (allowCreate) await this.authorize(userId, workspaceId);
    const documents: DocumentEditScope['documents'] = [];
    let bytes = 0;
    for (const docId of ids) {
      await this.authorize(userId, workspaceId, docId);
      // Check size before loading and converting the snapshot on small hosts.
      const metadata = await this.models.doc.getSnapshot(workspaceId, docId, {
        select: { size: true },
      });
      if (!metadata || metadata.size == null || metadata.size > 1024n * 1024n) {
        throw createHttpError(
          400,
          'This document is unavailable or too large for chat editing.'
        );
      }
      const snapshot = await this.reader.getDoc(workspaceId, docId);
      if (!snapshot || snapshot.bin.byteLength > 1024 * 1024)
        throw createHttpError(400, 'Cannot read the complete document.');
      assertMarkdownEditable(snapshot.bin);
      const doc = parseDocToMarkdownFromDocSnapshot(
        workspaceId,
        docId,
        snapshot.bin,
        false
      );
      // Refuse a lossy round trip: never discard images, databases or canvas data.
      if (
        doc.unknownBlocks.length ||
        doc.knownUnsupportedBlocks.some(
          block =>
            ![':affine:note', ':affine:surface'].some(suffix =>
              block.endsWith(suffix)
            )
        )
      ) {
        throw createHttpError(
          400,
          'This document contains blocks that chat cannot safely edit. Edit it in the document editor instead.'
        );
      }
      bytes += Buffer.byteLength(doc.markdown, 'utf8');
      if (bytes > MAX_TEXT_BYTES)
        throw createHttpError(
          400,
          'Selected documents exceed the chat editing limit.'
        );
      documents.push({
        docId,
        title: doc.title,
        revision: documentRevision(snapshot),
        markdown: doc.markdown,
      });
    }
    return { documents, allowCreate };
  }

  async propose(options: CopilotChatOptions, input: DocumentEdit) {
    this.enabled();
    const {
      user,
      workspace,
      session,
      documentEditScope: scope,
    } = options ?? {};
    if (!user || !workspace || !session || !scope)
      throw createHttpError(403, 'No document editing scope.');
    const edit = DocumentEditSchema.parse(input);
    const doc =
      edit.operation === 'create'
        ? undefined
        : scope.documents.find(doc => doc.docId === edit.docId);
    if (edit.operation === 'create' ? !scope.allowCreate : !doc) {
      throw createHttpError(
        403,
        'Allow editing this specific document before requesting a proposal.'
      );
    }
    await this.authorize(
      user,
      workspace,
      edit.operation === 'create' ? undefined : edit.docId
    );
    if ('content' in edit) {
      edit.content = edit.content
        .replace(/^[ \t]{0,3}#\s+[^\n]*\n*/, '')
        .trim();
      if (
        !edit.content ||
        Buffer.byteLength(edit.content, 'utf8') > MAX_TEXT_BYTES ||
        /!\[|<\/?[a-z][^>]*>/i.test(edit.content)
      ) {
        throw createHttpError(
          400,
          'Propose a nonempty text document within 32 KiB, without images.'
        );
      }
    }
    // Bound Redis use even if a model repeatedly calls the proposal tools.
    const count = await this.cache.increaseWithTtl(
      `copilot:edit:limit:${user}`,
      TTL
    );
    if (!count || count > 20)
      throw createHttpError(
        400,
        'Too many document proposals. Try again in 15 minutes.'
      );
    const proposalId = randomUUID();
    const proposal: Proposal = {
      userId: user,
      workspaceId: workspace,
      sessionId: session,
      edit,
      revision: doc?.revision,
      before:
        edit.operation === 'rename'
          ? (doc?.title ?? '')
          : (doc?.markdown ?? ''),
      title: 'title' in edit ? edit.title : (doc?.title ?? ''),
      expiresAt: Date.now() + TTL,
    };
    if (
      !(await this.cache.set(`copilot:edit:${proposalId}`, proposal, {
        ttl: TTL,
      }))
    ) {
      throw createHttpError(
        503,
        'Cannot safely store the proposal. No document was changed.'
      );
    }
    return {
      status: 'proposed',
      proposalId,
      workspaceId: workspace,
      sessionId: session,
      operation: edit.operation,
      docId: edit.operation === 'create' ? undefined : edit.docId,
      title: proposal.title,
      before: proposal.before,
      after: 'content' in edit ? edit.content : edit.title,
      expiresAt: proposal.expiresAt,
      message:
        'Proposal only. Nothing has been saved. Ask the user to review and Apply or Cancel the preview in chat.',
    };
  }

  async decide(
    userId: string,
    proposalId: string,
    decision: 'apply' | 'cancel' | 'status'
  ) {
    this.enabled();
    const key = `copilot:edit:${proposalId}`;
    const proposal = await this.cache.get<Proposal>(key);
    if (
      !proposal ||
      proposal.userId !== userId ||
      proposal.expiresAt <= Date.now()
    ) {
      throw createHttpError(
        404,
        'Proposal unavailable or expired. Request a new preview.'
      );
    }
    if (
      !(await this.models.copilotSession.has(proposal.sessionId, userId, {
        workspaceId: proposal.workspaceId,
        deletedAt: null,
      }))
    ) {
      throw createHttpError(403, 'This conversation is no longer available.');
    }
    const { edit, workspaceId } = proposal;
    await this.authorize(
      userId,
      workspaceId,
      edit.operation === 'create' ? undefined : edit.docId
    );
    const receipt = await this.cache.get<Receipt>(`${key}:receipt`);
    if (receipt) return receipt;
    if (decision === 'status') {
      return {
        status: (await this.cache.has(`${key}:claimed`))
          ? 'uncertain'
          : 'proposed',
      };
    }
    // Atomic, fail-closed claim across processes. Never replay an ambiguous write.
    if (!(await this.cache.setnx(`${key}:claimed`, true, { ttl: TTL }))) {
      throw createHttpError(
        409,
        'This proposal was already handled or is being applied. Check the document before requesting another edit.'
      );
    }
    let result: Receipt = { status: 'cancelled' };
    if (decision === 'apply') {
      let docId: string;
      if (edit.operation === 'create') {
        docId = (
          await this.writer.createDoc(
            workspaceId,
            edit.title,
            edit.content,
            userId
          )
        ).docId;
      } else {
        docId = edit.docId;
        await using lock = await this.mutex.acquire(
          `copilot:document-edit:${workspaceId}:${docId}`
        );
        if (!lock)
          throw createHttpError(
            409,
            'Another document edit is in progress. Request a fresh preview after it finishes.'
          );
        if (edit.operation === 'update') {
          await this.writer.updateDoc(
            workspaceId,
            docId,
            edit.content,
            userId,
            proposal.revision
          );
        } else {
          await this.writer.updateDocMeta(
            workspaceId,
            docId,
            { title: edit.title },
            userId,
            proposal.revision
          );
        }
      }
      result = { status: 'applied', docId };
    }
    if (!(await this.cache.set(`${key}:receipt`, result, { ttl: TTL }))) {
      throw createHttpError(
        503,
        'Could not record the result. Check the document; do not apply this proposal again.'
      );
    }
    return result;
  }
}
