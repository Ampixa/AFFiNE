import test from 'ava';
import * as Y from 'yjs';

import {
  createDocWithMarkdown,
  parseYDocToMarkdown,
  updateDocWithMarkdown,
} from '../../../native';

const markdown =
  '| Name | Value |\n| --- | --- |\n| नेपाल | 1.2 × 10⁻³ |\n| Empty | |';

function load(binary: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, binary);
  return doc;
}

function table(doc: Y.Doc) {
  return [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(
    block => block.get('sys:flavour') === 'affine:table'
  )!;
}

function cells(block: Y.Map<unknown>) {
  return [...block.entries()].filter(
    ([key]) => key.startsWith('prop:cells.') && key.endsWith('.text')
  );
}

test('Markdown tables round-trip editable cells, Unicode, and empty values', t => {
  const binary = createDocWithMarkdown('Measurements', markdown, 'table-test');
  const doc = load(binary);
  const block = table(doc);
  t.truthy(block);
  t.is(cells(block).length, 6);
  for (const [, value] of cells(block)) t.true(value instanceof Y.Text);
  const cell = cells(block).find(
    ([, value]) => String(value) === 'नेपाल'
  )![1] as Y.Text;
  cell.insert(cell.length, ' edited');
  t.regex(
    parseYDocToMarkdown(Buffer.from(Y.encodeStateAsUpdate(doc)), 'table-test')
      .markdown,
    /नेपाल edited/
  );
  const reload = load(Y.encodeStateAsUpdate(doc));
  t.true(cells(table(reload)).every(([, value]) => value instanceof Y.Text));
  doc.destroy();
  reload.destroy();
});

test('Markdown update repairs legacy tables and preserves unchanged rich-text cells', t => {
  const doc = load(
    createDocWithMarkdown('Measurements', markdown, 'table-test')
  );
  const block = table(doc);
  const [cellKey, cell] = cells(block).find(
    ([, value]) => String(value) === 'Name'
  )! as [string, Y.Text];
  cell.format(0, cell.length, {
    background: 'var(--affine-text-highlight-yellow)',
  });
  const originalCell = cell;
  const before = Buffer.from(Y.encodeStateAsUpdate(doc));
  Y.applyUpdate(doc, updateDocWithMarkdown(before, markdown, 'table-test'));
  t.is(table(doc).get(cellKey), originalCell);
  t.is(
    originalCell.toDelta()[0].attributes?.background,
    'var(--affine-text-highlight-yellow)'
  );

  // Simulate a table written by affine_doc_loader 0.1.7 before this fix.
  const [legacyKey, legacyCell] = cells(block).find(
    ([, value]) => String(value) === 'नेपाल'
  )! as [string, Y.Text];
  block.set(legacyKey, legacyCell.toString());
  const orderKey = [...block.entries()]
    .filter(
      ([key]) => key.startsWith('prop:columns.') && key.endsWith('.order')
    )
    .sort(([, a], [, b]) => String(a).localeCompare(String(b)))[0][0];
  block.set(orderKey, '000000');
  const legacy = Buffer.from(Y.encodeStateAsUpdate(doc));
  Y.applyUpdate(doc, updateDocWithMarkdown(legacy, markdown, 'table-test'));
  t.true(table(doc).get(legacyKey) instanceof Y.Text);
  t.not(table(doc).get(orderKey), '000000');

  const updated = markdown.replace('1.2 × 10⁻³', '2.4 × 10⁻³');
  Y.applyUpdate(
    doc,
    updateDocWithMarkdown(
      Buffer.from(Y.encodeStateAsUpdate(doc)),
      updated,
      'table-test'
    )
  );
  t.true(cells(table(doc)).every(([, value]) => value instanceof Y.Text));
  t.regex(
    parseYDocToMarkdown(Buffer.from(Y.encodeStateAsUpdate(doc)), 'table-test')
      .markdown,
    /2.4 × 10⁻³/
  );
  doc.destroy();
});
