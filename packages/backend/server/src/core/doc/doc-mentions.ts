import { nanoid } from 'nanoid';
import * as Y from 'yjs';

// An AFFiNE `@` mention: one REFERENCE_NODE char carrying a `reference` attribute
// (blocksuite/affine/inlines/reference/src/utils.ts). The sidebar nests every doc
// a doc mentions under it, so a mention is what makes a "doc inside a doc".
const REFERENCE_NODE = ' ';
// The markdown parser drops `[](url)` entirely, and read_document exports a
// mention without alias as exactly that, so empty mention links get this text.
const PLACEHOLDER = '';

type DeltaOp = { insert: unknown; attributes?: Record<string, unknown> };

export class DocMentionError extends Error {}

function mentionHref(workspaceId: string) {
  const ws = workspaceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The form read_document writes (`/workspace/<ws>/<docId>`), optionally absolute.
  return new RegExp(
    `^(?:https?://[^/\\s]+)?/workspace/${ws}/([A-Za-z0-9_-]+)/?(?:[?#]\\S*)?$`
  );
}

/** Keeps empty-text mention links alive through the native markdown parser. */
export function protectMentionLinks(markdown: string, workspaceId: string) {
  const href = mentionHref(workspaceId);
  return markdown.replace(/\[\]\(([^)\s]+)\)/g, (link, url: string) =>
    href.test(url) ? `[${PLACEHOLDER}](${url})` : link
  );
}

function collectTexts(value: unknown, texts: Set<Y.Text>) {
  if (value instanceof Y.Text) texts.add(value);
  else if (value instanceof Y.Map || value instanceof Y.Array)
    value.forEach((child: unknown) => collectTexts(child, texts));
}

/** Turns mention links back into mentions and drops placeholders, in `texts` only. */
function restoreMentions(texts: Iterable<Y.Text>, workspaceId: string) {
  const href = mentionHref(workspaceId);
  for (const text of texts) {
    const edits: { at: number; length: number; insert?: DeltaOp }[] = [];
    let at = 0;
    for (const op of text.toDelta() as DeltaOp[]) {
      if (typeof op.insert !== 'string') {
        at += 1; // embeds occupy one position
        continue;
      }
      const { link, ...attributes } = op.attributes ?? {};
      const pageId =
        typeof link === 'string' ? href.exec(link)?.[1] : undefined;
      if (pageId) {
        edits.push({
          at,
          length: op.insert.length,
          insert: {
            insert: REFERENCE_NODE,
            attributes: {
              ...attributes,
              // No alias: the mention keeps showing the child's live title.
              reference: { type: 'LinkedPage', pageId },
            },
          },
        });
      } else {
        for (let i = op.insert.indexOf(PLACEHOLDER); i !== -1;) {
          edits.push({ at: at + i, length: 1 });
          i = op.insert.indexOf(PLACEHOLDER, i + 1);
        }
      }
      at += op.insert.length;
    }
    for (const edit of edits.reverse()) {
      text.delete(edit.at, edit.length);
      if (edit.insert)
        text.insert(
          edit.at,
          edit.insert.insert as string,
          edit.insert.attributes
        );
    }
  }
}

/**
 * Applies a native markdown update (or a whole new doc when `existing` is null)
 * and repairs the doc mentions the markdown round trip turned into plain links.
 * Only text touched by `update` is repaired, so links nobody edited stay as-is.
 */
export function applyKeepingMentions(
  existing: Uint8Array | null,
  update: Uint8Array,
  workspaceId: string
): Uint8Array {
  const doc = new Y.Doc();
  try {
    if (existing) Y.applyUpdate(doc, existing);
    const before = Y.encodeStateVector(doc);
    const blocks = doc.getMap('blocks');
    const touched = new Set<Y.Text>();
    const observer = (events: Y.YEvent<any>[]) => {
      for (const event of events) {
        if (event.target instanceof Y.Text) touched.add(event.target);
        else if (event.target instanceof Y.Map)
          for (const key of event.keysChanged)
            collectTexts(event.target.get(key), touched);
      }
    };
    blocks.observeDeep(observer);
    Y.applyUpdate(doc, update);
    blocks.unobserveDeep(observer);
    doc.transact(() => restoreMentions(touched, workspaceId));
    return Y.encodeStateAsUpdate(doc, before);
  } finally {
    doc.destroy();
  }
}

/** Ids of docs this doc mentions inline or embeds as a linked/synced doc card. */
export function mentionedDocIds(doc: Y.Doc) {
  const ids = new Set<string>();
  doc.getMap('blocks').forEach(block => {
    if (!(block instanceof Y.Map)) return;
    const pageId = block.get('prop:pageId');
    if (typeof pageId === 'string') ids.add(pageId);
    const text = block.get('prop:text');
    if (!(text instanceof Y.Text)) return;
    for (const op of text.toDelta() as DeltaOp[]) {
      const reference = op.attributes?.reference as
        | { pageId?: unknown }
        | undefined;
      if (typeof reference?.pageId === 'string') ids.add(reference.pageId);
    }
  });
  return ids;
}

/** Appends a paragraph holding an `@` mention of `childDocId`, unless already mentioned. */
export function appendDocMention(
  doc: Y.Doc,
  childDocId: string,
  editorId: string
) {
  if (mentionedDocIds(doc).has(childDocId)) return { added: false };

  const blocks = doc.getMap<unknown>('blocks');
  const flavour = (id: unknown) =>
    (blocks.get(id as string) as Y.Map<unknown> | undefined)?.get(
      'sys:flavour'
    );
  const page = [...blocks.values()].find(
    (block): block is Y.Map<unknown> =>
      block instanceof Y.Map && block.get('sys:flavour') === 'affine:page'
  );
  const pageChildren = page?.get('sys:children');
  const noteId =
    pageChildren instanceof Y.Array
      ? pageChildren.toArray().find(id => flavour(id) === 'affine:note')
      : undefined;
  const noteChildren = (
    blocks.get(noteId as string) as Y.Map<unknown> | undefined
  )?.get('sys:children');
  if (!(noteChildren instanceof Y.Array))
    throw new DocMentionError(
      'UNSUPPORTED_DOCUMENT: The parent document has no page body to add to.'
    );

  const blockId = nanoid();
  const now = Date.now();
  doc.transact(() => {
    const text = new Y.Text();
    blocks.set(
      blockId,
      new Y.Map<unknown>([
        ['sys:id', blockId],
        ['sys:flavour', 'affine:paragraph'],
        ['sys:version', 1],
        ['sys:children', new Y.Array()],
        ['prop:type', 'text'],
        ['prop:text', text],
        ['prop:collapsed', false],
        ['prop:meta:createdAt', now],
        ['prop:meta:updatedAt', now],
        ['prop:meta:createdBy', editorId],
        ['prop:meta:updatedBy', editorId],
      ])
    );
    text.insert(0, REFERENCE_NODE, {
      reference: { type: 'LinkedPage', pageId: childDocId },
    });
    noteChildren.push([blockId]);
  });
  return { added: true, blockId };
}
