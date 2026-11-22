import { Readable } from 'node:stream';

import { HttpStatus } from '@nestjs/common';
import { PrismaClient, WorkspaceMemberStatus } from '@prisma/client';
import ava, { TestFn } from 'ava';
import Sinon from 'sinon';
import supertest from 'supertest';
import { applyUpdate, Doc as YDoc, Map as YMap } from 'yjs';

import { PgWorkspaceDocStorageAdapter } from '../../core/doc';
import { WorkspaceBlobStorage } from '../../core/storage';
import { Models, PublicDocMode, WorkspaceRole } from '../../models';
import {
  addDocToRootDoc,
  mergeUpdatesInApplyWay,
  readAllDocIdsFromRootDoc,
} from '../../native';
import { createTestingApp, TestingApp, TestUser } from '../utils';

const test = ava as TestFn<{
  db: PrismaClient;
  app: TestingApp;
  u1: TestUser;
  storage: Sinon.SinonStubbedInstance<WorkspaceBlobStorage>;
  workspace: Sinon.SinonStubbedInstance<PgWorkspaceDocStorageAdapter>;
  models: Models;
}>;

test.before(async t => {
  const app = await createTestingApp({
    tapModule: m => {
      m.overrideProvider(WorkspaceBlobStorage)
        .useValue(Sinon.createStubInstance(WorkspaceBlobStorage))
        .overrideProvider(PgWorkspaceDocStorageAdapter)
        .useValue(Sinon.createStubInstance(PgWorkspaceDocStorageAdapter));
    },
  });

  const db = app.get(PrismaClient);

  t.context.u1 = await app.signupV1('u1@affine.pro');
  t.context.db = db;
  t.context.app = app;
  t.context.storage = app.get(WorkspaceBlobStorage);
  t.context.workspace = app.get(PgWorkspaceDocStorageAdapter);
  t.context.models = app.get(Models);

  await db.workspaceDoc.create({
    data: {
      workspace: {
        create: {
          id: 'public',
          accessPolicy: { create: { visibility: 'public' } },
        },
      },
      docId: 'private',
    },
  });

  await db.workspaceDoc.create({
    data: {
      workspace: {
        create: {
          id: 'private',
          accessPolicy: { create: {} },
        },
      },
      docId: 'public',
    },
  });

  await db.workspaceDoc.create({
    data: {
      workspace: {
        create: {
          id: 'totally-private',
          accessPolicy: { create: {} },
        },
      },
      docId: 'private',
    },
  });
  await db.docAccessPolicy.createMany({
    data: [
      { workspaceId: 'public', docId: 'private', visibility: 'private' },
      {
        workspaceId: 'private',
        docId: 'public',
        visibility: 'public',
        publicRole: 'external',
      },
      {
        workspaceId: 'totally-private',
        docId: 'private',
        visibility: 'private',
      },
    ],
  });
});

test.after.always(async t => {
  await t.context.app.close();
});

function blob() {
  function stream() {
    return Readable.from(Buffer.from('blob'));
  }

  const init = stream();
  const ret = {
    body: init,
    metadata: {
      contentType: 'text/plain',
      lastModified: new Date(),
      contentLength: 4,
    },
  };

  init.on('end', () => {
    ret.body = stream();
  });

  return ret;
}

// blob
test('public workspace does not grant anonymous or non-member blob access', async t => {
  const { app, storage } = t.context;

  // no authenticated user
  app.clearAuth();
  storage.get.resolves(blob());
  let res = await app.GET('/api/workspaces/public/blobs/test');

  t.is(res.status, HttpStatus.UNAUTHORIZED);

  // authenticated user
  await app.login(t.context.u1);
  res = await app.GET('/api/workspaces/public/blobs/test');

  t.is(res.status, HttpStatus.FORBIDDEN);
});

test('public pages do not expose unrelated workspace blobs', async t => {
  const { app, storage } = t.context;

  // no authenticated user
  app.clearAuth();
  storage.get.resolves(blob());
  let res = await app.GET('/api/workspaces/private/blobs/test');

  t.is(res.status, HttpStatus.UNAUTHORIZED);

  // authenticated user
  await app.login(t.context.u1);
  res = await app.GET('/api/workspaces/private/blobs/test');

  t.is(res.status, HttpStatus.FORBIDDEN);
});

test('should not be able to get private workspace with no public pages', async t => {
  const { app } = t.context;

  app.clearAuth();
  let res = await app.GET('/api/workspaces/totally-private/blobs/test');

  t.is(res.status, HttpStatus.UNAUTHORIZED);

  await app.login(t.context.u1);
  res = await app.GET('/api/workspaces/totally-private/blobs/test');

  t.is(res.status, HttpStatus.FORBIDDEN);
});

test('should be able to get permission granted workspace', async t => {
  const { app, storage } = t.context;

  await t.context.models.workspaceUser.set(
    'totally-private',
    t.context.u1.id,
    WorkspaceRole.Collaborator,
    { status: WorkspaceMemberStatus.Accepted }
  );

  storage.get.resolves(blob());
  await app.login(t.context.u1);
  const res = await app.GET('/api/workspaces/totally-private/blobs/test');

  t.is(res.status, HttpStatus.OK);
  t.is(res.text, 'blob');
  t.is(res.get('cache-control'), 'private, no-store');
  t.is(res.get('vary'), 'Cookie, Authorization');
  t.true(storage.get.lastCall.calledWith('totally-private', 'test', false));
});

test('legacy blob redirects stay authenticated and stream through the server', async t => {
  const { app, storage, u1 } = t.context;
  for (const suffix of ['', '?redirect=manual', '?redirect=true']) {
    app.clearAuth();
    storage.get.resetHistory();
    const url = `/api/workspaces/totally-private/blobs/test${suffix}`;
    t.is((await app.GET(url)).status, HttpStatus.UNAUTHORIZED);
    t.false(storage.get.called);
    await app.login(u1);
    storage.get.resolves(blob());
    const res = await app.GET(url);
    t.is(res.status, HttpStatus.OK);
    t.is(res.text, 'blob');
    t.is(res.get('location'), undefined);
    t.is(res.get('cache-control'), 'private, no-store');
    t.true(storage.get.lastCall.calledWith('totally-private', 'test', false));
  }
});

test('suspension and removal revoke blob access for an existing session', async t => {
  const { app, db, storage, u1, models } = t.context;
  await app.login(u1);
  try {
    for (const state of ['suspended', 'removed'] as const) {
      if (state === 'removed') {
        await db.workspaceMember.deleteMany({
          where: { workspaceId: 'totally-private', userId: u1.id },
        });
      } else {
        await db.workspaceMember.updateMany({
          where: { workspaceId: 'totally-private', userId: u1.id },
          data: { state },
        });
      }
      storage.get.resetHistory();
      const res = await app.GET('/api/workspaces/totally-private/blobs/test');
      t.is(res.status, HttpStatus.FORBIDDEN);
      t.false(storage.get.called);
    }
  } finally {
    await models.workspaceUser.set(
      'totally-private',
      u1.id,
      WorkspaceRole.Collaborator,
      {
        status: WorkspaceMemberStatus.Accepted,
      }
    );
  }
});

test('should return 404 if blob not found', async t => {
  const { app, storage } = t.context;

  storage.get.resolves({ body: undefined });
  await app.login(t.context.u1);
  const res = await app.GET('/api/workspaces/totally-private/blobs/test');

  t.is(res.status, HttpStatus.NOT_FOUND);
});

// doc
// Documents retain their own sharing rules; blob access requires membership.
test('should not be able to get private workspace with private page', async t => {
  const { app } = t.context;

  let res = await app.GET('/api/workspaces/private/docs/private-page');

  t.is(res.status, HttpStatus.FORBIDDEN);

  await app.login(t.context.u1);
  res = await app.GET('/api/workspaces/private/docs/private-page');

  t.is(res.status, HttpStatus.FORBIDDEN);
});

test('should be able to get doc', async t => {
  const { app, workspace: doc } = t.context;

  doc.getDoc.resolves({
    spaceId: '',
    docId: '',
    bin: Buffer.from([0, 0]),
    timestamp: Date.now(),
  });

  const res = await app.GET('/api/workspaces/private/docs/public');

  t.is(res.status, HttpStatus.OK);
  t.is(res.get('content-type'), 'application/octet-stream');
  t.deepEqual(res.body, Buffer.from([0, 0]));
});

test('should not expose legacy root doc for private workspace with public pages', async t => {
  const { app } = t.context;

  const res = await app.GET('/api/workspaces/private/docs/private');

  t.is(res.status, HttpStatus.FORBIDDEN);
});

test('should expose filtered public root doc for shared page', async t => {
  const { app, workspace: doc } = t.context;

  let root = addDocToRootDoc(Buffer.from([0, 0]), 'public', 'Public Doc');
  const privateUpdate = addDocToRootDoc(root, 'private-page', 'Private Doc');
  root = mergeUpdatesInApplyWay([root, privateUpdate]);

  doc.getDoc.resolves({
    spaceId: 'private',
    docId: 'private',
    bin: root,
    timestamp: Date.now(),
  });

  const res = await app.GET(
    '/api/workspaces/private/public-docs/public/root-doc'
  );

  t.is(res.status, HttpStatus.OK);
  const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
  t.deepEqual(readAllDocIdsFromRootDoc(body, false), ['public']);

  const ydoc = new YDoc({ guid: 'private' });
  t.notThrows(() =>
    applyUpdate(
      ydoc,
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    )
  );
  const pages = (ydoc.getMap('meta') as YMap<unknown>).get('pages') as
    | { toArray: () => Array<{ get: (key: string) => unknown }> }
    | undefined;
  t.deepEqual(
    pages?.toArray().map(page => page.get('id')),
    ['public']
  );
});

test('should expose public doc publish mode through HEAD route', async t => {
  const { app } = t.context;

  const res = await supertest(app.getHttpServer()).head(
    '/api/workspaces/private/public-docs/public'
  );

  t.is(res.status, HttpStatus.OK);
  t.is(res.get('publish-mode'), 'page');
});

test('should expose public doc binary through public route', async t => {
  const { app, workspace: doc } = t.context;

  doc.getDoc.resolves({
    spaceId: 'private',
    docId: 'public',
    bin: Buffer.from([1, 2, 3]),
    timestamp: Date.now(),
  });

  const res = await app.GET('/api/workspaces/private/public-docs/public');

  t.is(res.status, HttpStatus.OK);
  t.is(res.get('content-type'), 'application/octet-stream');
  t.is(res.get('publish-mode'), 'page');
  t.deepEqual(res.body, Buffer.from([1, 2, 3]));
});

test('should record doc view when reading doc', async t => {
  const { app, workspace: doc, models } = t.context;

  doc.getDoc.resolves({
    spaceId: '',
    docId: '',
    bin: Buffer.from([0, 0]),
    timestamp: Date.now(),
  });

  const record = Sinon.stub(
    models.workspaceAnalytics,
    'recordDocView'
  ).resolves();
  await app.login(t.context.u1);

  const res = await app.GET('/api/workspaces/private/docs/public');
  t.is(res.status, HttpStatus.OK);
  t.true(record.calledOnce);
  t.like(record.firstCall.args[0], {
    workspaceId: 'private',
    docId: 'public',
    userId: t.context.u1.id,
    isGuest: false,
  });

  record.restore();
});

test('should be able to change page publish mode', async t => {
  const { app, workspace: doc, models } = t.context;

  doc.getDoc.resolves({
    spaceId: '',
    docId: '',
    bin: Buffer.from([0, 0]),
    timestamp: Date.now(),
  });

  let res = await app.GET('/api/workspaces/private/docs/public');

  t.is(res.status, HttpStatus.OK);
  t.is(res.get('publish-mode'), 'page');

  await models.doc.upsertMeta('private', 'public', {
    mode: PublicDocMode.Edgeless,
  });

  res = await app.GET('/api/workspaces/private/docs/public');

  t.is(res.status, HttpStatus.OK);
  t.is(res.get('publish-mode'), 'edgeless');
});
