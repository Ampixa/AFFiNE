import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { Text } from '../reactive/text/index.js';
import { TestWorkspace } from '../test/test-workspace.js';
import {
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
} from './test-schema.js';

function emptyStore() {
  const workspace = new TestWorkspace();
  workspace.meta.initialize();
  const doc = workspace.createDoc();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
    ],
  });
  doc.load();
  return { workspace, store };
}

function fixture() {
  const { workspace, store } = emptyStore();
  const root = store.addBlock('affine:page');
  const noteId = store.addBlock('affine:note', {}, root);
  const firstId = store.addBlock('affine:paragraph', {}, noteId);
  const note = store.getBlock(noteId)!.model;
  return { workspace, store, note, noteId, firstId };
}

describe('child models after remote structural updates', () => {
  it('tracks insertions and removals after the children array is replaced', () => {
    const { store, note, noteId, firstId } = fixture();
    expect(note.children.map(child => child.id)).toEqual([firstId]);

    store.spaceDoc.transact(() => {
      note.yBlock.set('sys:children', Y.Array.from([firstId]));
    }, 'remote-editor');

    const secondId = store.addBlock('affine:paragraph', {}, noteId);
    const second = store.getBlock(secondId)!.model;
    expect(store.getParent(second)).toBe(note);
    // Paragraph/list Enter commands require this exact relationship.
    expect(note.children.indexOf(second)).toBe(1);

    store.deleteBlock(store.getBlock(firstId)!.model);
    expect(note.children.map(child => child.id)).toEqual([secondId]);
  });

  it('uses the replacement block when a remote update preserves its ID', () => {
    const { store, note, noteId, firstId } = fixture();
    const replacement = note.yBlock.clone();
    store.spaceDoc.transact(() => {
      store.spaceDoc.getMap('blocks').set(noteId, replacement);
    }, 'remote-editor');

    const current = store.getBlock(noteId)!.model;
    expect(current.yBlock).toBe(replacement);
    const secondId = store.addBlock('affine:paragraph', {}, noteId);
    expect(current.children.map(child => child.id)).toEqual([
      firstId,
      secondId,
    ]);
  });

  it('keeps both editors changes when text and new paragraphs arrive concurrently', () => {
    const a = fixture();
    const b = emptyStore();
    Y.applyUpdate(b.store.spaceDoc, Y.encodeStateAsUpdate(a.store.spaceDoc));
    a.store.resetHistory();
    b.store.resetHistory();

    // The remote writer replaces the children array while both editors are open.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(a.store.spaceDoc));
    const remoteVector = Y.encodeStateVector(remote);
    const note = remote.getMap<Y.Map<unknown>>('blocks').get(a.noteId)!;
    note.set('sys:children', Y.Array.from([a.firstId]));
    const structuralUpdate = Y.encodeStateAsUpdate(remote, remoteVector);
    Y.applyUpdate(a.store.spaceDoc, structuralUpdate, 'remote-editor');
    Y.applyUpdate(b.store.spaceDoc, structuralUpdate, 'remote-editor');

    const aVector = Y.encodeStateVector(a.store.spaceDoc);
    const bVector = Y.encodeStateVector(b.store.spaceDoc);
    a.store.transact(() => {
      a.store.getBlock(a.firstId)!.model.text!.insert('Editor A ', 0);
    });
    b.store.transact(() => {
      b.store.getBlock(a.firstId)!.model.text!.insert('Editor B ', 0);
    });
    const aId = a.store.addBlock(
      'affine:paragraph',
      { text: new Text('A new paragraph') },
      a.noteId,
      1
    );
    const bId = b.store.addBlock(
      'affine:paragraph',
      { text: new Text('B new paragraph') },
      a.noteId,
      1
    );
    const aUpdate = Y.encodeStateAsUpdate(a.store.spaceDoc, aVector);
    const bUpdate = Y.encodeStateAsUpdate(b.store.spaceDoc, bVector);
    Y.applyUpdate(a.store.spaceDoc, bUpdate, 'editor-b');
    Y.applyUpdate(b.store.spaceDoc, aUpdate, 'editor-a');

    expect(a.store.spaceDoc.getMap('blocks').toJSON()).toEqual(
      b.store.spaceDoc.getMap('blocks').toJSON()
    );
    for (const { store } of [a, b]) {
      const text = store.getBlock(a.firstId)!.model.text!.toString();
      expect(text).toContain('Editor A');
      expect(text).toContain('Editor B');
      const parent = store.getBlock(a.noteId)!.model;
      expect(new Set(parent.children.map(child => child.id))).toEqual(
        new Set([a.firstId, aId, bId])
      );
      for (const id of [aId, bId]) {
        expect(
          parent.children.indexOf(store.getBlock(id)!.model)
        ).toBeGreaterThan(-1);
      }
    }

    // Undo is scoped to this editor; the other person's text must survive.
    a.store.undo();
    expect(a.store.getBlock(a.firstId)!.model.text!.toString()).toContain(
      'Editor B'
    );
    expect(a.store.getBlock(bId)!.model.text!.toString()).toBe(
      'B new paragraph'
    );
  });
});
