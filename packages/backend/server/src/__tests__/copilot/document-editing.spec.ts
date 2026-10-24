// Match production initialization order for the existing circular runtime providers.
import '../../plugins/copilot/runtime/capability-runtime';

import test from 'ava';
import * as Y from 'yjs';

import type { Cache, Config, EventBus, Mutex } from '../../base';
import { type DocReader, DocWriter } from '../../core/doc';
import type { PgWorkspaceDocStorageAdapter } from '../../core/doc/adapters/workspace';
import type { PermissionAccess } from '../../core/permission';
import type { Models } from '../../models';
import { createDocWithMarkdown } from '../../native';
import { CopilotController } from '../../plugins/copilot/controller';
import type { CopilotChatOptions } from '../../plugins/copilot/providers/types';
import {
  assertMarkdownEditable,
  DocumentEditing,
} from '../../plugins/copilot/runtime/document-editing';
import { ToolRuntime } from '../../plugins/copilot/runtime/tool-runtime';

function fixture() {
  let revision = 1;
  let bin = createDocWithMarkdown('Roadmap', 'Original paragraph', 'doc');
  const entries = new Map<string, unknown>();
  const denied = new Set<string>();
  const saves: string[] = [];
  const flags = { cacheDown: false, writeFails: false, sessionDeleted: false };
  const config = { copilotSelfHosted: { documentEditing: true } } as Config;
  const access = {
    can: async (action: string) => !denied.has(action),
    doc: (id: string) => ({
      can: async (action: string) => id === 'doc' && !denied.has(action),
    }),
  };
  const ac = {
    user: () => ({
      workspace: (id: string) =>
        id === 'workspace'
          ? access
          : { can: async () => false, doc: () => ({ can: async () => false }) },
    }),
  } as unknown as PermissionAccess;
  const models = {
    workspace: { get: async () => ({ enableAi: true }) },
    doc: { getSnapshot: async () => ({ size: BigInt(bin.length) }) },
    copilotSession: {
      has: async (
        session: string,
        user: string,
        options: { workspaceId: string }
      ) =>
        session === 'session' &&
        user === 'user' &&
        options.workspaceId === 'workspace' &&
        !flags.sessionDeleted,
    },
  } as unknown as Models;
  const reader = {
    getDoc: async () => ({ bin, timestamp: revision }),
  } as unknown as DocReader;
  const storage = {
    getDoc: async () => ({ bin, timestamp: revision }),
    pushDocUpdates: async (
      _workspace: string,
      _id: string,
      updates: Uint8Array[]
    ) => {
      if (flags.writeFails) throw new Error('storage unavailable');
      saves.push('update');
      bin = Buffer.from(Y.mergeUpdates([bin, ...updates]));
      return ++revision;
    },
    isEmptyBin: () => true,
  } as unknown as PgWorkspaceDocStorageAdapter;
  const writer = new DocWriter(storage, {
    emit: () => {},
  } as unknown as EventBus);
  // Creation is separately authorized; record writes without fabricating a workspace root.
  writer.createDoc = async () => {
    saves.push('create');
    return { docId: 'created' };
  };
  const cache = {
    get: async (key: string) => entries.get(key),
    has: async (key: string) => entries.has(key),
    set: async (key: string, value: unknown) => {
      if (flags.cacheDown) return false;
      entries.set(key, value);
      return true;
    },
    setnx: async (key: string, value: unknown) => {
      if (flags.cacheDown || entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
    increaseWithTtl: async (key: string) => {
      const count = Number(entries.get(key) ?? 0) + 1;
      entries.set(key, count);
      return count;
    },
  } as unknown as Cache;
  const service = new DocumentEditing(
    config,
    ac,
    reader,
    writer,
    models,
    cache,
    {
      acquire: async () => ({ [Symbol.asyncDispose]: async () => {} }),
    } as unknown as Mutex
  );
  const options: NonNullable<CopilotChatOptions> = {
    user: 'user',
    workspace: 'workspace',
    session: 'session',
  };
  const prepare = async () => {
    options.documentEditScope = await service.prepare(
      'user',
      'workspace',
      ['doc'],
      ['doc'],
      true
    );
  };
  const proposal = async () => {
    await prepare();
    return service.propose(options, {
      operation: 'update',
      docId: 'doc',
      content: 'Revised paragraph',
    });
  };
  return {
    service,
    options,
    proposal,
    prepare,
    entries,
    denied,
    saves,
    flags,
    config,
    writer,
    reader,
    change: () => {
      revision++;
    },
    bin: () => bin,
  };
}

test('read-only scope stays read-only; selection and editor/create permissions are enforced', async t => {
  const f = fixture();
  t.is(await f.service.prepare('user', 'workspace', ['doc']), undefined);
  await t.throwsAsync(
    f.service.propose(f.options, {
      operation: 'update',
      docId: 'doc',
      content: 'Changed',
    })
  );
  await t.throwsAsync(f.service.prepare('user', 'workspace', [], ['doc']));
  await t.throwsAsync(
    f.service.prepare('user', 'another-workspace', ['doc'], ['doc'])
  );
  for (const permission of ['Doc.Read', 'Doc.Update', 'Workspace.CreateDoc']) {
    f.denied.add(permission);
    await t.throwsAsync(f.prepare());
    f.denied.delete(permission);
  }
  await f.prepare();
  await t.throwsAsync(
    f.service.propose(f.options, {
      operation: 'update',
      docId: 'outside',
      content: 'Changed',
    })
  );
  t.deepEqual(f.saves, []);
});

test('propose, preview, apply and duplicate Apply use a single real document update', async t => {
  const f = fixture();
  const p = await f.proposal();
  t.is(p.status, 'proposed');
  t.true(p.before.includes('Original paragraph'));
  t.is(p.after, 'Revised paragraph');
  t.deepEqual(f.saves, []);
  t.deepEqual(await f.service.decide('user', p.proposalId, 'status'), {
    status: 'proposed',
  });
  t.deepEqual(await f.service.decide('user', p.proposalId, 'apply'), {
    status: 'applied',
    docId: 'doc',
  });
  t.deepEqual(await f.service.decide('user', p.proposalId, 'apply'), {
    status: 'applied',
    docId: 'doc',
  });
  t.deepEqual(f.saves, ['update']);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, f.bin());
  doc.getMap('blocks');
  t.true(JSON.stringify(doc.toJSON()).includes('Revised paragraph'));
  doc.destroy();
});

test('other users, removed sessions and revoked permissions cannot apply', async t => {
  const f = fixture();
  const p = await f.proposal();
  await t.throwsAsync(f.service.decide('other-user', p.proposalId, 'apply'));
  f.denied.add('Doc.Update');
  await t.throwsAsync(f.service.decide('user', p.proposalId, 'apply'));
  f.denied.clear();
  f.flags.sessionDeleted = true;
  await t.throwsAsync(f.service.decide('user', p.proposalId, 'apply'));
  t.deepEqual(f.saves, []);
});

test('stale previews cannot overwrite a newer revision or rename it', async t => {
  const f = fixture();
  const p = await f.proposal();
  f.change();
  await t.throwsAsync(f.service.decide('user', p.proposalId, 'apply'), {
    message: /changed after the preview/,
  });
  await t.throwsAsync(
    f.writer.updateDocMeta('workspace', 'doc', { title: 'New' }, 'user', '1'),
    { message: /changed after the preview/ }
  );
  t.deepEqual(f.saves, []);
});

test('Cancel is final; concurrent applies and ambiguous writes never repeat', async t => {
  const f = fixture();
  const p = await f.proposal();
  t.deepEqual(await f.service.decide('user', p.proposalId, 'cancel'), {
    status: 'cancelled',
  });
  t.deepEqual(await f.service.decide('user', p.proposalId, 'apply'), {
    status: 'cancelled',
  });
  const p2 = await f.proposal();
  await Promise.allSettled([
    f.service.decide('user', p2.proposalId, 'apply'),
    f.service.decide('user', p2.proposalId, 'apply'),
  ]);
  t.deepEqual(f.saves, ['update']);
  const p3 = await f.proposal();
  f.flags.writeFails = true;
  await t.throwsAsync(f.service.decide('user', p3.proposalId, 'apply'));
  f.flags.writeFails = false;
  await t.throwsAsync(f.service.decide('user', p3.proposalId, 'apply'));
  t.deepEqual(await f.service.decide('user', p3.proposalId, 'status'), {
    status: 'uncertain',
  });
  t.deepEqual(f.saves, ['update']);
});

test('create needs opt-in and cannot save until Apply; expiry and cache failure fail closed', async t => {
  const f = fixture();
  await f.prepare();
  if (!f.options.documentEditScope) throw new Error('missing scope');
  f.options.documentEditScope.allowCreate = false;
  await t.throwsAsync(
    f.service.propose(f.options, {
      operation: 'create',
      title: 'New',
      content: 'Body',
    })
  );
  f.options.documentEditScope.allowCreate = true;
  const p = await f.service.propose(f.options, {
    operation: 'create',
    title: 'New',
    content: 'Body',
  });
  t.deepEqual(f.saves, []);
  await f.service.decide('user', p.proposalId, 'apply');
  t.deepEqual(f.saves, ['create']);
  const p2 = await f.proposal();
  const stored = f.entries.get(`copilot:edit:${p2.proposalId}`) as {
    expiresAt: number;
  };
  stored.expiresAt = 0;
  await t.throwsAsync(f.service.decide('user', p2.proposalId, 'apply'));
  f.flags.cacheDown = true;
  await t.throwsAsync(f.proposal());
});

test('failed reads and unsupported rich text cannot turn into replacement content', async t => {
  const f = fixture();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, f.bin());
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const paragraph = [...blocks.values()].find(
    block => block.get('sys:flavour') === 'affine:paragraph'
  );
  if (!paragraph) throw new Error('missing paragraph');
  const text = paragraph.get('prop:text') as Y.Text;
  text.format(0, 3, { background: 'yellow' });
  t.throws(() => assertMarkdownEditable(Y.encodeStateAsUpdate(doc)));
  doc.destroy();
  f.reader.getDoc = async () => {
    throw new Error('read failed');
  };
  await t.throwsAsync(f.prepare(), { message: 'read failed' });
  t.deepEqual(f.saves, []);
});

test('browser tool runtime never exposes immediate writes, even with development prompts', async t => {
  const f = fixture();
  const runtime = new ToolRuntime(
    f.config,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    f.service
  );
  const options = {
    ...f.options,
    tools: ['docCreate', 'docUpdate', 'docUpdateMeta'] as const,
  };
  t.deepEqual(
    await runtime.getTools({ ...options, tools: [...options.tools] }, ''),
    {}
  );
  await f.prepare();
  const tools = await runtime.getTools(
    { ...f.options, tools: [...options.tools] },
    ''
  );
  const result = await tools.doc_update.execute?.(
    { doc_id: 'doc', content: 'Proposed' },
    {}
  );
  t.is((result as { status: string }).status, 'proposed');
  t.deepEqual(f.saves, []);
});

test('apply endpoint accepts only a decision, never caller-supplied document content or identity', async t => {
  const f = fixture();
  const p = await f.proposal();
  const controller = new CopilotController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    f.service
  );
  await t.throwsAsync(
    controller.decideDocumentEdit({ id: 'user' } as never, p.proposalId, '', {
      decision: 'apply',
    })
  );
  await t.throwsAsync(
    controller.decideDocumentEdit({ id: 'user' } as never, p.proposalId, '1', {
      decision: 'apply',
      content: 'injected replacement',
    })
  );
  await t.throwsAsync(
    controller.decideDocumentEdit(
      { id: 'other-user' } as never,
      p.proposalId,
      '1',
      { decision: 'apply' }
    )
  );
  t.deepEqual(f.saves, []);
  t.deepEqual(
    await controller.decideDocumentEdit(
      { id: 'user' } as never,
      p.proposalId,
      '1',
      { decision: 'apply' }
    ),
    { status: 'applied', docId: 'doc' }
  );
});
