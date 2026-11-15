import test from 'ava';
import type { Response } from 'express';

import type { CurrentUser } from '../../core/auth';
import type { PgWorkspaceDocStorageAdapter } from '../../core/doc';
import type { DocReader } from '../../core/doc/reader';
import type { PermissionAccess } from '../../core/permission';
import type {
  CommentAttachmentStorage,
  WorkspaceBlobStorage,
} from '../../core/storage';
import { WorkspacesController } from '../../core/workspaces/controller';
import type { Models } from '../../models';

function fixture(denied = false, missing = false) {
  const calls: unknown[][] = [];
  const binary = Buffer.from([0, 0]);
  const ac = {
    user: (user: string) => ({
      doc: (workspace: string, doc: string) => ({
        assert: async (action: string) => {
          calls.push(['authorize', user, workspace, doc, action]);
          if (denied) throw new Error('denied');
        },
      }),
    }),
  } as unknown as PermissionAccess;
  const storage = {
    getDocBinNative: async (workspace: string, doc: string) => {
      calls.push(['snapshot', workspace, doc]);
      return missing ? undefined : binary;
    },
  } as unknown as PgWorkspaceDocStorageAdapter;
  // Any analytics, sync write or metadata mutation would fail this fixture.
  const controller = new WorkspacesController(
    {} as WorkspaceBlobStorage,
    {} as CommentAttachmentStorage,
    ac,
    storage,
    {} as DocReader,
    {} as Models
  );
  const response = {
    setHeader: (name: string, value: string) =>
      calls.push(['header', name, value]),
    send: (value: Buffer) => calls.push(['body', value]),
  } as unknown as Response;
  const invoke = () =>
    controller.taskSnapshot(
      { id: 'reader' } as CurrentUser,
      'workspace',
      'doc',
      response
    );
  return { calls, binary, invoke };
}

test('task snapshot authorizes before reading and never records a document visit', async t => {
  const f = fixture();
  await f.invoke();
  t.deepEqual(f.calls, [
    ['authorize', 'reader', 'workspace', 'doc', 'Doc.Read'],
    ['snapshot', 'workspace', 'doc'],
    ['header', 'Cache-Control', 'private, no-store'],
    ['header', 'content-type', 'application/octet-stream'],
    ['body', f.binary],
  ]);
});

test('task snapshot denies access before reading any document bytes', async t => {
  const f = fixture(true);
  await t.throwsAsync(f.invoke, { message: 'denied' });
  t.deepEqual(f.calls, [
    ['authorize', 'reader', 'workspace', 'doc', 'Doc.Read'],
  ]);
});

test('task snapshot reports a missing document without returning bytes', async t => {
  const f = fixture(false, true);
  await t.throwsAsync(f.invoke);
  t.is(f.calls.length, 2);
});
