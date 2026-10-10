import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { mergeUpdates } from 'yjs';

import { PermissionAccess } from '../../../core/permission';
import {
  type DocumentSearchProjectionV1,
  projectDocSearch,
  readAllDocIdsFromWorkspaceSnapshot,
} from '../../../core/utils/blocksuite';
import { Models } from '../../../models';
import type { DocumentSearchHit } from './document';

const MAX_DOCUMENTS = 256;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTION_BYTES = 256 * 1024;
const DEADLINE_MS = 5000;
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

export type LocalSearchCoverage = {
  complete: boolean;
  searchedDocuments: number;
  skippedDocuments: number;
  scope: 'live-readable-workspace-documents';
  note: string;
};

/** Small-workspace fallback. No persistent index, embeddings or attachment IO.
 * Cached projections are never authorization: recheck live scope and ACLs on
 * every request, including warm-cache requests. Only bounded passages leave it.
 */
@Injectable()
export class LocalDocumentSearch {
  private busy = false;
  private cacheBytes = 0;
  private readonly cache = new Map<
    string,
    { hash: string; projection: DocumentSearchProjectionV1; bytes: number }
  >();

  constructor(
    private readonly ac: PermissionAccess,
    private readonly models: Models
  ) {}

  async search(
    userId: string,
    workspaceId: string,
    query: string,
    docIds: string[] | undefined,
    limit: number,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    const terms = [...new Set(normalize(query).match(/[\p{L}\p{M}\p{N}]+/gu))];
    if (!terms.length || terms.length > 32 || query.length > 2000) {
      throw new Error('INVALID_SEARCH_QUERY');
    }
    // Do not queue unbounded concurrent document decodes on a small server.
    if (this.busy) throw new Error('SEARCH_UNAVAILABLE');
    this.busy = true;
    try {
      return await this.run(userId, workspaceId, terms, docIds, limit, signal);
    } finally {
      this.busy = false;
    }
  }

  private async run(
    userId: string,
    workspaceId: string,
    terms: string[],
    docIds: string[] | undefined,
    limit: number,
    signal?: AbortSignal
  ) {
    const deadline = Date.now() + DEADLINE_MS;
    const access = this.ac.user(userId).workspace(workspaceId);
    await access.assert('Workspace.Read');
    const workspace = await this.models.workspace.get(workspaceId);
    if (!workspace?.enableAi || !workspace.enableDocEmbedding) {
      throw new Error('SEARCH_UNAVAILABLE');
    }
    const root = await this.read(workspaceId, workspaceId);
    if (!root) throw new Error('SEARCH_UNAVAILABLE');
    let live: string[];
    try {
      live = readAllDocIdsFromWorkspaceSnapshot(root.bin, false);
    } catch {
      throw new Error('SEARCH_UNAVAILABLE');
    }
    const selected = docIds ? new Set(docIds) : null;
    const eligible: { docId: string }[] = [];
    const liveIds = [...new Set(live)].filter(
      id => id !== workspaceId && (!selected || selected.has(id))
    );
    // Batch authorization before reading any document content. Do not use
    // workspace membership or the model's requested IDs as a substitute.
    for (let i = 0; i < liveIds.length; i += 64) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error('SEARCH_UNAVAILABLE');
      eligible.push(
        ...((await access.docs(
          liveIds.slice(i, i + 64).map(docId => ({ docId })),
          'Doc.Read'
        )) ?? [])
      );
    }
    const ignored = new Set(
      await this.models.copilotWorkspace.checkIgnoredDocs(
        workspaceId,
        eligible.map(doc => doc.docId)
      )
    );
    const readable = eligible.filter(doc => !ignored.has(doc.docId));
    const coverage: LocalSearchCoverage = {
      complete: true,
      searchedDocuments: 0,
      skippedDocuments: 0,
      scope: 'live-readable-workspace-documents',
      note: 'Literal keyword search of persisted Page/canvas text only. Attachment contents and the web are not searched.',
    };
    let bytes = root.bytes;
    let candidates: DocumentSearchHit[] = [];
    for (let i = 0; i < readable.length; i++) {
      signal?.throwIfAborted();
      if (
        i >= MAX_DOCUMENTS ||
        bytes >= MAX_INPUT_BYTES ||
        Date.now() >= deadline
      ) {
        coverage.skippedDocuments += readable.length - i;
        break;
      }
      const { docId } = readable[i];
      const doc = await this.read(workspaceId, docId);
      if (!doc) {
        coverage.skippedDocuments++;
        continue;
      }
      bytes += doc.bytes;
      let projection: DocumentSearchProjectionV1;
      try {
        projection = this.project(workspaceId, docId, doc.bin, doc.timestamp);
      } catch {
        coverage.skippedDocuments++;
        continue;
      }
      if (projection.warnings.length) coverage.complete = false;
      coverage.searchedDocuments++;
      candidates.push(...this.match(projection, terms, doc.timestamp));
      // Bound accumulated output even if every document matches.
      candidates.sort(
        (a, b) => b.score - a.score || a.docId.localeCompare(b.docId)
      );
      candidates = candidates.slice(0, Math.min(limit, 20));
    }
    signal?.throwIfAborted();
    // A document might have been trashed, unshared, or opted out during a cold
    // scan. Never return a stale ACL decision or a removed document.
    const currentRoot = await this.read(workspaceId, workspaceId);
    if (
      !currentRoot ||
      !Buffer.from(root.bin).equals(Buffer.from(currentRoot.bin))
    ) {
      throw new Error('SEARCH_UNAVAILABLE');
    }
    const currentWorkspace = await this.models.workspace.get(workspaceId);
    if (!currentWorkspace?.enableAi || !currentWorkspace.enableDocEmbedding) {
      throw new Error('SEARCH_UNAVAILABLE');
    }
    candidates = (await access.docs(candidates, 'Doc.Read')) ?? [];
    const nowIgnored = new Set(
      await this.models.copilotWorkspace.checkIgnoredDocs(
        workspaceId,
        candidates.map(hit => hit.docId)
      )
    );
    signal?.throwIfAborted();
    coverage.complete &&= coverage.skippedDocuments === 0;
    if (!coverage.complete) {
      coverage.note +=
        ' Coverage is incomplete (size, time, unsupported content or document limits). Do not claim an absent fact/document does not exist; narrow doc_ids or use a provisioned keyword indexer.';
    }
    return {
      retrievalMode: 'local-keyword' as const,
      degradedReason: 'INDEXED_SEARCH_UNAVAILABLE',
      coverage,
      hits: candidates.filter(hit => !nowIgnored.has(hit.docId)),
    };
  }

  private async read(workspaceId: string, docId: string) {
    const data = await this.models.doc.getBoundedSearchUpdates(
      workspaceId,
      docId
    );
    if (!data || data.limited) return null;
    try {
      return {
        bin: mergeUpdates(data.updates),
        timestamp: data.timestamp,
        bytes: data.bytes,
      };
    } catch {
      return null;
    }
  }

  private project(
    workspaceId: string,
    docId: string,
    bin: Uint8Array,
    timestamp: Date
  ) {
    const key = JSON.stringify([workspaceId, docId]);
    const hash = createHash('sha256').update(bin).digest('hex');
    const cached = this.cache.get(key);
    if (cached?.hash === hash) return cached.projection;
    if (cached) {
      this.cacheBytes -= cached.bytes;
      this.cache.delete(key);
    }
    const projection = projectDocSearch(bin, docId, timestamp.toISOString());
    const bytes = Buffer.byteLength(JSON.stringify(projection));
    if (bytes > MAX_PROJECTION_BYTES)
      throw new Error('SEARCH_DOCUMENT_TOO_LARGE');
    while (
      this.cache.size &&
      (this.cacheBytes + bytes > MAX_CACHE_BYTES || this.cache.size >= 128)
    ) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cacheBytes -= oldest[1].bytes;
      this.cache.delete(oldest[0]);
    }
    this.cache.set(key, { hash, projection, bytes });
    this.cacheBytes += bytes;
    return projection;
  }

  private match(
    projection: DocumentSearchProjectionV1,
    terms: string[],
    updatedAt: Date
  ): DocumentSearchHit[] {
    const title = normalize(projection.title);
    const titleScore = terms.filter(term => title.includes(term)).length * 4;
    const hits: DocumentSearchHit[] = [];
    for (const unit of projection.units) {
      const text = normalize(unit.text);
      const score =
        titleScore + terms.filter(term => text.includes(term)).length;
      if (!score) continue;
      // Slice the original text to preserve accents/script and never emit HTML.
      // Case normalization may change length; the offset is only an excerpt hint.
      const offset = Math.max(
        0,
        Math.min(...terms.map(term => text.indexOf(term)).filter(i => i >= 0)) -
          120
      );
      const start = Number.isFinite(offset) ? offset : 0;
      hits.push({
        docId: projection.docId,
        title: projection.title.slice(0, 300),
        excerpt: unit.text.slice(start, start + 1000),
        visibility: unit.visibility,
        blockId: unit.blockId,
        elementId: unit.elementId,
        frameId: unit.frameId,
        unitId: unit.unitId,
        updatedAt,
        score,
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 3);
  }
}
