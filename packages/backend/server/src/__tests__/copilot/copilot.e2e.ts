import '../../plugins/copilot';

import { randomUUID } from 'node:crypto';

import { createCopilotMessageMutation } from '@affine/graphql';
import { McpAccessMode, PrismaClient } from '@prisma/client';
import type { TestFn } from 'ava';
import ava from 'ava';
import * as Y from 'yjs';

import { Config } from '../../base';
import { ServerFeature, ServerService } from '../../core';
import { AuthService } from '../../core/auth';
import {
  DocReader,
  DocWriter,
  PgWorkspaceDocStorageAdapter,
} from '../../core/doc';
import { DocRole } from '../../core/permission/types';
import { Models, WorkspaceMemberStatus, WorkspaceRole } from '../../models';
import { CopilotFeatureService } from '../../plugins/copilot/feature';
import { McpCredentialService } from '../../plugins/copilot/mcp/credential';
import { WorkspaceMcpProvider } from '../../plugins/copilot/mcp/provider';
import { installMockCopilotRuntime } from '../mocks';
import { createTestingApp, createWorkspace, type TestingApp } from '../utils';
import {
  chatWithImages,
  chatWithText,
  createCopilotMessage,
  createCopilotSession,
  getCopilotSession,
  getHistories,
  sse2array,
} from '../utils/copilot';

type Context = {
  app: TestingApp;
  restoreRuntime: () => void;
};

const test = ava.serial as TestFn<Context>;

test.before(async t => {
  const restoreRuntime = installMockCopilotRuntime();
  t.context = {
    app: await createTestingApp(),
    restoreRuntime,
  };
});

test.beforeEach(async t => {
  await t.context.app.initTestingDB();
});

test.after.always(async t => {
  t.context.restoreRuntime?.();
  await t.context.app?.close();
});

test('disabled copilot hides its server feature and rejects every API transport', async t => {
  const { app } = t.context;
  const config = app.get(Config);
  const feature = app.get(CopilotFeatureService);
  const server = app.get(ServerService);
  await app.signupV1();
  const workspace = await createWorkspace(app);

  config.copilot.enabled = false;
  feature.onConfigChanged({ updates: { copilot: { enabled: false } } });
  try {
    t.false(server.features.includes(ServerFeature.Copilot));
    await t.throwsAsync(
      createCopilotSession(
        app,
        workspace.id,
        randomUUID(),
        'Chat With AFFiNE AI'
      )
    );
    await app.GET('/api/copilot/unsplash/photos').expect(403);
    await app
      .POST(`/api/workspaces/${workspace.id}/mcp`)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      .expect(403);
  } finally {
    config.copilot.enabled = true;
    feature.onConfigChanged({ updates: { copilot: { enabled: true } } });
  }
});

test('session, message, local context restriction and durable history share one public contract', async t => {
  const { app } = t.context;
  await app.signupV1();
  const workspace = await createWorkspace(app);
  const docId = randomUUID();
  const sessionId = await createCopilotSession(
    app,
    workspace.id,
    docId,
    'Chat With AFFiNE AI'
  );

  t.deepEqual(await getCopilotSession(app, workspace.id, sessionId), {
    id: sessionId,
    docId,
    parentSessionId: null,
    pinned: false,
    promptName: 'Chat With AFFiNE AI',
  });

  const token = await createCopilotMessage(app, sessionId, 'hello');
  const [beforeStream] = await getHistories(app, {
    workspaceId: workspace.id,
    docId,
  });
  t.is(beforeStream.sessionId, sessionId);
  t.deepEqual(beforeStream.messages, []);

  t.is(
    await chatWithText(app, sessionId, token),
    'generate text to text stream'
  );
  t.is(
    await chatWithText(app, sessionId, token),
    'generate text to text stream'
  );
  const [history] = await getHistories(app, {
    workspaceId: workspace.id,
    docId,
  });
  t.deepEqual(
    history.messages.map(message => [message.role, message.content]),
    [
      ['user', 'hello'],
      ['assistant', 'generate text to text stream'],
      ['assistant', 'generate text to text stream'],
    ]
  );
  t.is(history.messages.filter(message => message.role === 'user').length, 1);
  t.not(history.messages[0].id, token);

  const localSessionId = await createCopilotSession(
    app,
    randomUUID(),
    null,
    'Chat With AFFiNE AI'
  );
  t.truthy(await createCopilotMessage(app, localSessionId, 'local hello'));
  const localContextResponse = await app
    .POST('/graphql')
    .set('x-operation-name', createCopilotMessageMutation.op)
    .send({
      query: createCopilotMessageMutation.query,
      variables: {
        options: {
          sessionId: localSessionId,
          content: 'local context',
          params: {
            scopeSelectors: [{ kind: 'document', id: randomUUID() }],
          },
        },
      },
    })
    .expect(200);
  t.is(
    localContextResponse.body.errors?.[0]?.message,
    "Local workspaces don't support attachments or references."
  );
  await t.throwsAsync(
    app.gql({
      query: createCopilotMessageMutation,
      variables: {
        options: {
          sessionId: localSessionId,
          content: 'local attachment',
          blobs: [new File(['attachment'], 'attachment.txt')],
        },
      },
    }),
    {
      message: "Local workspaces don't support attachments or references.",
    }
  );
});

test('chat and history endpoints reject a different user', async t => {
  const { app } = t.context;
  const owner = await app.signupV1();
  const workspace = await createWorkspace(app);
  const sessionId = await createCopilotSession(
    app,
    workspace.id,
    randomUUID(),
    'Chat With AFFiNE AI'
  );
  const token = await createCopilotMessage(app, sessionId, 'private');
  await app.signupV1();

  await t.throwsAsync(chatWithText(app, sessionId, token));
  await t.throwsAsync(getHistories(app, { workspaceId: workspace.id }));

  await app.switchUser(owner);
  t.is(
    await chatWithText(app, sessionId, token),
    'generate text to text stream'
  );
});

test('image SSE emits persisted attachment events for action sessions', async t => {
  const { app } = t.context;
  await app.signupV1();
  const workspace = await createWorkspace(app);
  const sessionId = await createCopilotSession(
    app,
    workspace.id,
    randomUUID(),
    'Generate image'
  );
  const token = await createCopilotMessage(app, sessionId, 'Panda');

  const events = sse2array(await chatWithImages(app, sessionId, token));
  const attachment = events.find(event => event.event === 'attachment');
  t.truthy(attachment?.data);
});

test('MCP credentials remain endpoint-bound through rotate, revoke and expiry', async t => {
  const { app } = t.context;
  const auth = app.get(AuthService);
  const credentials = app.get(McpCredentialService);
  const db = app.get(PrismaClient);
  const models = app.get(Models);
  const provider = app.get(WorkspaceMcpProvider);
  const user = await auth.signUp(`mcp-${randomUUID()}@affine.pro`, '123456');
  const target = await models.workspace.create(user.id);
  const other = await models.workspace.create(user.id);
  const issued = await credentials.create({
    userId: user.id,
    workspaceId: target.id,
    name: 'Claude Desktop',
    accessMode: McpAccessMode.READ_ONLY,
    expirationDays: 90,
  });

  t.like(await credentials.authenticate(issued.token, target.id), {
    userId: user.id,
    workspaceId: target.id,
    accessMode: McpAccessMode.READ_ONLY,
  });
  await t.throwsAsync(credentials.authenticate(issued.token, other.id));
  const response = await app
    .POST(`/api/workspaces/${target.id}/mcp`)
    .set('Authorization', `Bearer ${issued.token}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    .expect(200);
  t.like(response.body, { jsonrpc: '2.0', id: 1 });
  t.deepEqual(
    (await provider.for(user.id, target.id, McpAccessMode.READ_ONLY)).tools.map(
      tool => tool.name
    ),
    [
      'read_document',
      'doc_search',
      'list_kanban_boards',
      'read_kanban_board',
      'list_folders',
      'list_task_members',
      'list_tasks',
      'read_task',
      'list_task_comments',
    ]
  );

  const rotated = await credentials.rotate(
    issued.credential.id,
    user.id,
    target.id,
    30
  );
  t.like((await credentials.list(user.id, target.id))[0], {
    status: 'ROTATING',
  });
  await credentials.authenticate(issued.token, target.id);
  await credentials.revoke(rotated.credential.id, user.id, target.id);
  await t.throwsAsync(credentials.authenticate(issued.token, target.id));
  await t.throwsAsync(credentials.authenticate(rotated.token, target.id));

  const disabled = await credentials.create({
    userId: user.id,
    workspaceId: target.id,
    name: 'Disabled user',
    accessMode: McpAccessMode.READ_ONLY,
    expirationDays: 30,
  });
  await models.user.update(user.id, { disabled: true });
  await t.throwsAsync(credentials.authenticate(disabled.token, target.id));
  await models.user.update(user.id, { disabled: false });
  await db.mcpCredential.update({
    where: { id: disabled.credential.id },
    data: { expiresAt: new Date(0) },
  });
  await t.throwsAsync(credentials.authenticate(disabled.token, target.id));
});

test('folder and child MCP tools resolve at boot and enforce real member doc access', async t => {
  const { app } = t.context;
  const descriptor = Object.getOwnPropertyDescriptor(env, 'mcpWriteEnabled');
  Object.defineProperty(env, 'mcpWriteEnabled', {
    configurable: true,
    get: () => true,
  });
  t.teardown(() => {
    if (descriptor) Object.defineProperty(env, 'mcpWriteEnabled', descriptor);
    else Reflect.deleteProperty(env, 'mcpWriteEnabled');
  });
  const owner = await app.signupV1();
  const ws = await createWorkspace(app);
  const models = app.get(Models);
  const writer = app.get(DocWriter);
  const reader = app.get(DocReader);
  const storage = app.get(PgWorkspaceDocStorageAdapter);
  const member = await models.user.create({
    email: `folder-${randomUUID()}@example.test`,
  });
  await models.workspaceUser.set(ws.id, member.id, WorkspaceRole.Collaborator, {
    status: WorkspaceMemberStatus.Accepted,
  });
  const parent = await writer.createDoc(
    ws.id,
    'Parent',
    'Preserve this body',
    owner.id
  );
  const child = await writer.createDoc(ws.id, 'Child', 'Child body', owner.id);
  const privateDoc = await writer.createDoc(
    ws.id,
    'Secret',
    'Private body',
    owner.id
  );
  await models.doc.setDefaultRole(ws.id, parent.docId, DocRole.Editor);
  await models.doc.setDefaultRole(ws.id, child.docId, DocRole.Reader);
  await models.doc.setDefaultRole(ws.id, privateDoc.docId, DocRole.None);
  const folders = new Y.Doc();
  for (const [id, data] of Object.entries({
    folder: { type: 'folder', data: 'Funding', parentId: null, index: 'a0' },
    hidden: {
      type: 'doc',
      data: privateDoc.docId,
      parentId: 'folder',
      index: 'a0',
    },
  })) {
    const row = folders.getMap(id);
    for (const [key, value] of Object.entries(data)) row.set(key, value);
  }
  await storage.pushDocUpdates(
    ws.id,
    `db$${ws.id}$folders`,
    [Y.encodeStateAsUpdate(folders)],
    owner.id
  );
  folders.destroy();
  const server = await app
    .get(WorkspaceMcpProvider)
    .for(member.id, ws.id, McpAccessMode.READ_WRITE);
  const call = (name: string, args: Record<string, unknown>) =>
    server.tools
      .find(tool => tool.name === name)!
      .execute(args, { signal: new AbortController().signal });
  const listed = await call('list_folders', {});
  t.falsy(listed.isError);
  t.deepEqual(JSON.parse(listed.content[0].text).folders[0].docIds, []);
  t.false(JSON.stringify(listed).includes(privateDoc.docId));
  t.true(
    (
      await call('add_child_document', {
        parentDocId: parent.docId,
        childDocId: privateDoc.docId,
      })
    ).isError
  );
  t.falsy(
    (
      await call('add_document_to_folder', {
        folderId: 'folder',
        docId: child.docId,
      })
    ).isError
  );
  const nested = await call('add_child_document', {
    parentDocId: parent.docId,
    childDocId: child.docId,
  });
  t.falsy(nested.isError);
  t.true(JSON.parse(nested.content[0].text).added);
  const again = await call('add_child_document', {
    parentDocId: parent.docId,
    childDocId: child.docId,
  });
  t.false(JSON.parse(again.content[0].text).added);
  const body = await reader.getDocMarkdown(ws.id, parent.docId, true);
  t.true(body!.markdown.includes('Preserve this body'));
  t.true(body!.markdown.includes(child.docId));
  await models.doc.setDefaultRole(ws.id, parent.docId, DocRole.Reader);
  t.true(
    (
      await call('add_child_document', {
        parentDocId: parent.docId,
        childDocId: child.docId,
      })
    ).isError
  );
  t.is(
    (await reader.getDocMarkdown(ws.id, parent.docId, true))!.markdown,
    body!.markdown
  );
});
