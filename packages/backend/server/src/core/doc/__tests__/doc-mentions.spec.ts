import test from 'ava';
import * as Y from 'yjs';

import { createDocWithMarkdown, updateDocWithMarkdown } from '../../../native';
import { parseDocToMarkdownFromDocSnapshot } from '../../utils/blocksuite';
import {
  appendDocMention,
  applyKeepingMentions,
  mentionedDocIds,
  protectMentionLinks,
} from '../doc-mentions';

const WS = 'ws-1';
const DOC = 'parent';

function load(binary: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, binary);
  return doc;
}
const mentions = (binary: Uint8Array) => mentionedDocIds(load(binary));
// What read_document hands the agent.
const read = (binary: Uint8Array) =>
  parseDocToMarkdownFromDocSnapshot(WS, DOC, binary).markdown;
// What DocWriter.updateDoc / createDoc now do.
function update(binary: Uint8Array, markdown: string) {
  const delta = applyKeepingMentions(
    binary,
    updateDocWithMarkdown(
      Buffer.from(binary),
      protectMentionLinks(markdown, WS),
      DOC
    ),
    WS
  );
  return Y.mergeUpdates([binary, delta]);
}
function create(markdown: string) {
  return applyKeepingMentions(
    null,
    createDocWithMarkdown('Parent', protectMentionLinks(markdown, WS), DOC),
    WS
  );
}
function withChild(binary: Uint8Array, childId: string) {
  const doc = load(binary);
  const before = Y.encodeStateVector(doc);
  const result = appendDocMention(doc, childId, 'editor');
  return {
    result,
    binary: Y.mergeUpdates([binary, Y.encodeStateAsUpdate(doc, before)]),
    again: appendDocMention(doc, childId, 'editor'),
  };
}
function links(binary: Uint8Array) {
  const found: string[] = [];
  load(binary)
    .getMap('blocks')
    .forEach(block => {
      const text = (block as Y.Map<unknown>).get('prop:text');
      if (text instanceof Y.Text)
        for (const op of text.toDelta())
          if (op.attributes?.link) found.push(op.attributes.link);
    });
  return found;
}

test('appendDocMention adds one @ mention paragraph, idempotently', t => {
  const { result, binary, again } = withChild(create('Intro'), 'child');
  t.true(result.added);
  t.deepEqual(again, { added: false });
  t.deepEqual([...mentions(binary)], ['child']);
  t.regex(read(binary), /\[\]\(\/workspace\/ws-1\/child\)/);
});

test('trap: the plain markdown round trip drops the mention', t => {
  const { binary } = withChild(create('Intro'), 'child');
  const markdown = read(binary);
  const raw = Y.mergeUpdates([
    binary,
    updateDocWithMarkdown(Buffer.from(binary), markdown, DOC),
  ]);
  t.false(mentions(raw).has('child'));
});

test('update_document keeps mentions it read back, even next to edits', t => {
  const { binary } = withChild(create('Intro'), 'child');
  const unchanged = update(binary, read(binary));
  t.deepEqual([...mentions(unchanged)], ['child']);

  const edited = update(binary, read(binary).replace('Intro', 'New intro'));
  t.deepEqual([...mentions(edited)], ['child']);
  t.regex(read(edited), /New intro/);
  t.false(read(edited).includes(''));
});

test('agent-written doc links become mentions; untouched links stay links', t => {
  // Seeded with the raw native writer, so this is a plain link a user made.
  const seeded = createDocWithMarkdown(
    'Parent',
    'Old [ref](/workspace/ws-1/keep)\n\nIntro',
    DOC
  );
  const next = update(
    seeded,
    read(seeded).replace(
      'Intro',
      'Budget: [Budget](/workspace/ws-1/budget) and [site](https://example.com)'
    )
  );
  t.deepEqual([...mentions(next)], ['budget']);
  t.deepEqual(links(next).sort(), [
    '/workspace/ws-1/keep',
    'https://example.com',
  ]);

  t.deepEqual([...mentions(create('[x](/workspace/ws-1/a)'))], ['a']);
  t.deepEqual(
    [...mentions(create('[x](/workspace/other-ws/a)'))],
    [],
    'links into other workspaces are left alone'
  );
});

test('code keeps a literal empty mention link verbatim', t => {
  const binary = create('```\n[](/workspace/ws-1/a)\n```');
  t.deepEqual([...mentions(binary)], []);
  t.regex(read(binary), /\[\]\(\/workspace\/ws-1\/a\)/);
  t.false(read(binary).includes(''));
});
