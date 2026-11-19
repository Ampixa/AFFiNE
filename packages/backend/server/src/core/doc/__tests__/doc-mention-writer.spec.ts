import test from 'ava';
import * as Y from 'yjs';

import { createDocWithMarkdown } from '../../../native';
import { mentionedDocIds } from '../doc-mentions';
import { DocWriter } from '../writer';

function fixture() {
  const docs = new Map<string, Uint8Array>([
    ['parent', createDocWithMarkdown('Parent', 'Keep this text', 'parent')],
    ['child', createDocWithMarkdown('Child', 'Child text', 'child')],
  ]);
  const state = {
    locked: false,
    missing: false,
    read: () => {},
    write: async () => {},
    checks: 0,
  };
  const writes: string[] = [];
  const writer = new DocWriter(
    {
      getDoc: async (_ws: string, id: string) => {
        state.read();
        const bin = state.missing && id === 'child' ? undefined : docs.get(id);
        return bin ? { bin } : null;
      },
      pushDocUpdates: async (
        _ws: string,
        id: string,
        updates: Uint8Array[]
      ) => {
        if (!state.locked) throw new Error('Lock released early');
        await state.write();
        if (!state.locked) throw new Error('Lock released during write');
        docs.set(id, Y.mergeUpdates([docs.get(id)!, ...updates]));
        writes.push(id);
        return Date.now();
      },
      isEmptyBin: () => true,
    } as never,
    { emit: () => {} } as never,
    {
      acquire: async () => {
        if (state.locked) return undefined;
        state.locked = true;
        return {
          [Symbol.asyncDispose]: async () => {
            state.locked = false;
          },
        };
      },
    } as never
  );
  return { writer, state, docs, writes };
}
const signal = new AbortController().signal;
const allowed = async () => {};

test('child mentions serialize overlapping writes and preserve the parent body', async t => {
  const f = fixture();
  let started!: () => void;
  let release!: () => void;
  const writing = new Promise<void>(resolve => {
    started = resolve;
  });
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  f.state.write = async () => {
    started();
    await hold;
  };
  const first = f.writer.addDocMention(
    'ws',
    'parent',
    'child',
    'u',
    signal,
    allowed
  );
  await writing;
  try {
    await t.throwsAsync(
      f.writer.addDocMention('ws', 'parent', 'child', 'u', signal, allowed),
      { message: /busy/ }
    );
  } finally {
    release();
  }
  t.true((await first).added);
  t.false(
    (
      await f.writer.addDocMention(
        'ws',
        'parent',
        'child',
        'u',
        signal,
        allowed
      )
    ).added
  );
  t.deepEqual(f.writes, ['parent']);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, f.docs.get('parent')!);
  t.deepEqual([...mentionedDocIds(doc)], ['child']);
  t.true(
    JSON.stringify(doc.getMap('blocks').toJSON()).includes('Keep this text')
  );
  doc.destroy();
});

test('child mentions reject missing targets, revoked access and aborted reads', async t => {
  const missing = fixture();
  missing.state.missing = true;
  await t.throwsAsync(
    missing.writer.addDocMention('ws', 'parent', 'child', 'u', signal, allowed)
  );
  t.deepEqual(missing.writes, []);
  const revoked = fixture();
  await t.throwsAsync(
    revoked.writer.addDocMention(
      'ws',
      'parent',
      'child',
      'u',
      signal,
      async () => {
        if (++revoked.state.checks === 2) throw new Error('revoked');
      }
    ),
    { message: 'revoked' }
  );
  t.deepEqual(revoked.writes, []);
  const aborted = fixture();
  const controller = new AbortController();
  aborted.state.read = () => controller.abort();
  await t.throwsAsync(
    aborted.writer.addDocMention(
      'ws',
      'parent',
      'child',
      'u',
      controller.signal,
      allowed
    )
  );
  t.deepEqual(aborted.writes, []);
});
