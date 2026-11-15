import type { Text as YText } from 'yjs';

/** Removes only references recorded by the old task-link implementation.
 * Existing prose, other document references, and block structure stay intact.
 * This changes current content, not retained sync history or backups.
 */
export function removeLegacyLinkReferences(
  texts: Iterable<YText>,
  legacyIds: ReadonlySet<string>
) {
  let removed = 0;
  for (const text of new Set(texts)) {
    const changes: { index: number; length: number; remove: boolean }[] = [];
    let index = 0;
    for (const delta of text.toDelta()) {
      const length = typeof delta.insert === 'string' ? delta.insert.length : 1;
      const ref = delta.attributes?.reference;
      if (
        ref?.type === 'LinkedPage' &&
        typeof ref.pageId === 'string' &&
        legacyIds.has(ref.pageId)
      ) {
        changes.push({
          index,
          length,
          remove: delta.insert === ' ' || typeof delta.insert !== 'string',
        });
      }
      index += length;
    }
    for (const change of changes.reverse()) {
      if (change.remove) text.delete(change.index, change.length);
      else text.format(change.index, change.length, { reference: null });
      removed++;
    }
  }
  return removed;
}
