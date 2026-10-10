import test from 'ava';

import {
  CopilotSelectedSourcesFailed,
  CopilotSelectedSourcesLimitExceeded,
  CopilotSelectedSourcesProcessing,
  CopilotSelectedSourcesUnavailable,
} from '../../base';
import type { BackendRuntimeEmbeddingJob } from '../../core/backend-runtime';
import type { DocMarkdown, DocReader } from '../../core/doc/reader';
import type { PermissionAccess } from '../../core/permission';
import type { Models } from '../../models';
import type { PromptMessage } from '../../plugins/copilot/providers/types';
import type { CapabilityRuntime } from '../../plugins/copilot/runtime/capability-runtime';
import type { ConversationHost } from '../../plugins/copilot/runtime/hosts/conversation-host';
import type { ImageResultHost } from '../../plugins/copilot/runtime/hosts/image-result-host';
import type { TurnPersistence } from '../../plugins/copilot/runtime/hosts/turn-persistence';
import {
  SelectedDocumentContext,
  withSelectedDocumentContext,
} from '../../plugins/copilot/runtime/selected-document-context';
import type { SelectedFileContext } from '../../plugins/copilot/runtime/selected-file-context';
import { TurnOrchestrator } from '../../plugins/copilot/runtime/turn-orchestrator';

function fixture() {
  const calls: unknown[][] = [];
  const workspace = { enableAi: true, enableDocEmbedding: true };
  const documents = new Map<string, DocMarkdown>([
    [
      'one',
      {
        title: 'Test Page',
        markdown: 'Synthetic document content.',
        revision: '123',
        knownUnsupportedBlocks: [
          'note-id:affine:note',
          'surface-id:affine:surface',
        ],
        unknownBlocks: [],
      },
    ],
  ]);
  const sizes = new Map<string, bigint | null>([['one', 100n]]);
  const denied = new Set<string>();
  const ac = {
    user: (user: string) => ({
      workspace: (workspaceId: string) => ({
        doc: (doc: string) => ({
          can: async (action: string) => {
            calls.push(['permission', user, workspaceId, doc, action]);
            return !denied.has(doc);
          },
        }),
      }),
    }),
  } as unknown as PermissionAccess;
  const reader = {
    getDocMarkdown: async (...args: [string, string, boolean]) => {
      calls.push(['read', ...args]);
      return documents.get(args[1]) ?? null;
    },
  } as unknown as DocReader;
  const models = {
    workspace: { get: async () => workspace },
    doc: {
      getSnapshot: async (...args: [string, string, unknown]) => {
        calls.push(['snapshot', ...args]);
        const size = sizes.get(args[1]);
        return size === undefined ? null : { size };
      },
    },
  } as unknown as Models;
  const service = new SelectedDocumentContext(ac, reader, models);
  return { service, calls, workspace, documents, sizes, denied, reader };
}

test('selected Page text is read with fresh permissions and persisted revision', async t => {
  const f = fixture();
  const message = await f.service.read('user', 'workspace', ['one', 'one']);
  t.is(message.role, 'user');
  t.regex(message.content, /untrusted source material/);
  t.regex(message.content, /does not contain canvas/);
  const payload = JSON.parse(message.content.split('\n').slice(1).join('\n'));
  t.deepEqual(payload.documents, [
    {
      doc_id: 'one',
      title: 'Test Page',
      revision: '123',
      markdown: 'Synthetic document content.',
    },
  ]);
  t.deepEqual(f.calls, [
    ['permission', 'user', 'workspace', 'one', 'Doc.Read'],
    ['snapshot', 'workspace', 'one', { select: { size: true } }],
    ['read', 'workspace', 'one', false],
  ]);
});

test('all permissions are checked before reading any selected document', async t => {
  const f = fixture();
  f.denied.add('revoked');
  await t.throwsAsync(f.service.read('user', 'workspace', ['one', 'revoked']), {
    instanceOf: CopilotSelectedSourcesUnavailable,
  });
  t.true(f.calls.every(call => call[0] === 'permission'));
});

for (const setting of ['enableAi', 'enableDocEmbedding'] as const) {
  test(`workspace ${setting} opt-out prevents the fallback`, async t => {
    const f = fixture();
    f.workspace[setting] = false;
    await t.throwsAsync(f.service.read('user', 'workspace', ['one']), {
      instanceOf: CopilotSelectedSourcesUnavailable,
    });
    t.deepEqual(f.calls, []);
  });
}

test('five unique selections fail before document reads', async t => {
  const f = fixture();
  await t.throwsAsync(
    f.service.read('user', 'workspace', ['1', '2', '3', '4', '5']),
    {
      instanceOf: CopilotSelectedSourcesLimitExceeded,
    }
  );
  t.deepEqual(f.calls, []);
});

test('large snapshots are rejected before markdown conversion', async t => {
  const f = fixture();
  f.sizes.set('one', 1024n * 1024n + 1n);
  await t.throwsAsync(f.service.read('user', 'workspace', ['one']), {
    instanceOf: CopilotSelectedSourcesLimitExceeded,
  });
  t.false(f.calls.some(call => call[0] === 'read'));
});

test('unknown snapshot sizes cannot bypass the preliminary size check', async t => {
  const f = fixture();
  f.sizes.set('one', null);
  await t.throwsAsync(f.service.read('user', 'workspace', ['one']), {
    instanceOf: CopilotSelectedSourcesUnavailable,
  });
  t.false(f.calls.some(call => call[0] === 'read'));
});

test('the context limit uses total UTF-8 bytes, including titles and JSON escaping', async t => {
  for (const field of ['markdown', 'title'] as const) {
    const f = fixture();
    f.documents.get('one')![field] = 'क'.repeat(12_000);
    await t.throwsAsync(f.service.read('user', 'workspace', ['one']), {
      instanceOf: CopilotSelectedSourcesLimitExceeded,
    });
  }
  const f = fixture();
  f.documents.get('one')!.markdown = '\\'.repeat(17_000);
  await t.throwsAsync(f.service.read('user', 'workspace', ['one']), {
    instanceOf: CopilotSelectedSourcesLimitExceeded,
  });
});

test('combined context is bounded and never silently truncated', async t => {
  const f = fixture();
  f.documents.get('one')!.markdown = 'a'.repeat(17_000);
  f.documents.set('two', { ...f.documents.get('one')! });
  f.sizes.set('two', 100n);
  await t.throwsAsync(f.service.read('user', 'workspace', ['one', 'two']), {
    instanceOf: CopilotSelectedSourcesLimitExceeded,
  });
});

for (const kind of [
  'snapshot',
  'markdown',
  'empty',
  'unsupported',
  'unknown',
]) {
  test(`${kind} source fails closed rather than dropping a selection`, async t => {
    const f = fixture();
    if (kind === 'snapshot') f.sizes.clear();
    if (kind === 'markdown') f.documents.clear();
    if (kind === 'empty') f.documents.get('one')!.markdown = '  ';
    if (kind === 'unsupported')
      f.documents.get('one')!.knownUnsupportedBlocks = ['affine:embed'];
    if (kind === 'unknown')
      f.documents.get('one')!.unknownBlocks = ['unrecognized'];
    await t.throwsAsync(f.service.read('user', 'workspace', ['one']), {
      instanceOf: CopilotSelectedSourcesUnavailable,
    });
  });
}

test('pre-aborted requests do not read any source', async t => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await t.throwsAsync(
    f.service.read('user', 'workspace', ['one'], controller.signal),
    {
      message: 'cancelled',
    }
  );
  t.deepEqual(f.calls, []);
});

test('cancellation during conversion stops before sending document content', async t => {
  const f = fixture();
  const controller = new AbortController();
  f.reader.getDocMarkdown = async () => {
    controller.abort(new Error('cancelled'));
    return f.documents.get('one')!;
  };
  await t.throwsAsync(
    f.service.read('user', 'workspace', ['one'], controller.signal),
    {
      message: 'cancelled',
    }
  );
});

test('context is ephemeral user-level data before the question, not transcript mutation', t => {
  const messages: PromptMessage[] = [
    { role: 'system', content: 'System instructions' },
    { role: 'user', content: 'Previous question' },
    { role: 'assistant', content: 'Previous answer' },
    { role: 'user', content: 'Explain this page' },
  ];
  const original = structuredClone(messages);
  const context: PromptMessage = { role: 'user', content: 'Source data' };
  const result = withSelectedDocumentContext(messages, context);
  t.deepEqual(messages, original);
  t.deepEqual(result, [...messages.slice(0, 3), context, messages[3]]);
  t.throws(() => withSelectedDocumentContext([messages[0]], context), {
    instanceOf: CopilotSelectedSourcesUnavailable,
  });
});

function orchestratorFixture(error?: Error) {
  const f = fixture();
  const scope = {
    mode: 'required',
    requiredDocIds: ['one'],
    requiredArtifactIds: [] as string[],
    preferredSourceIds: [],
  };
  const messages: PromptMessage[] = [
    { role: 'user', content: 'Explain this page' },
  ];
  const session = {
    config: {
      workspaceId: 'workspace',
      userId: 'user',
      sessionId: 'session',
      promptName: 'chat',
    },
    finish: () => messages,
  };
  let preflights = 0;
  const runtimeMessages: PromptMessage[][] = [];
  const persisted: unknown[][] = [];
  const routes: unknown[] = [];
  const runtime = {
    assertRoute: async (...args: unknown[]) => {
      routes.push(args);
    },
    streamText: async function* (
      _conditions: unknown,
      messages: PromptMessage[]
    ) {
      runtimeMessages.push(messages);
      yield 'Answer';
    },
    streamObject: async function* (
      _conditions: unknown,
      messages: PromptMessage[]
    ) {
      runtimeMessages.push(messages);
      yield { type: 'text-delta', textDelta: 'Answer' };
    },
  } as unknown as CapabilityRuntime;
  const persistence = {
    persistTextResult: async (...args: unknown[]) => {
      persisted.push(args);
    },
    persistObjectResult: async (...args: unknown[]) => {
      persisted.push(args);
    },
  } as unknown as TurnPersistence;
  const embeddings = {
    prepareSelectedDocuments: async () => {
      preflights++;
      if (error) throw error;
    },
  } as unknown as BackendRuntimeEmbeddingJob;
  const conversations = {
    prepareTurn: async () => ({
      session,
      latestTurn: { scopeSnapshot: { retrieval: scope } },
      params: {},
      messageId: 'message',
    }),
    buildLatestTurnPromptParams: () => ({}),
  } as unknown as ConversationHost;
  const orchestrator = new TurnOrchestrator(
    conversations,
    runtime,
    {} as ImageResultHost,
    persistence,
    embeddings,
    f.service,
    {
      read: async () => ({
        role: 'user',
        content: 'Selected file',
        attachments: [
          { kind: 'bytes', data: 'YQ==', mimeType: 'application/pdf' },
        ],
      }),
    } as unknown as SelectedFileContext
  );
  return {
    ...f,
    orchestrator,
    scope,
    messages,
    runtimeMessages,
    routes,
    persisted,
    preflights: () => preflights,
  };
}

for (const transport of ['streamText', 'streamObject'] as const) {
  test(`${transport} uses selected context without persisting or logging sources`, async t => {
    const f = orchestratorFixture(new CopilotSelectedSourcesUnavailable());
    const beforeScope = structuredClone(f.scope);
    const result = await f.orchestrator[transport]('user', 'session', {});
    for await (const _chunk of result.stream) {
      /* consume the provider call */
    }
    t.is(f.runtimeMessages[0].length, 2);
    t.regex(f.runtimeMessages[0][0].content, /Synthetic document content/);
    t.deepEqual(f.runtimeMessages[0][1], f.messages[0]);
    t.deepEqual(result.finalMessage, f.messages);
    t.false(JSON.stringify(f.persisted).includes('Synthetic document content'));
    t.is(f.messages.length, 1);
    t.deepEqual(f.scope, beforeScope);
    t.is(f.preflights(), 1);
  });
}

test('healthy indexing and unselected workspace chat keep the existing path', async t => {
  const f = orchestratorFixture();
  const result = await f.orchestrator.streamText('user', 'session', {});
  t.is(result.finalMessage, f.messages);
  t.deepEqual(f.calls, []);
  t.is(f.preflights(), 1);
  f.scope.mode = 'workspace';
  await f.orchestrator.streamText('user', 'session', {});
  t.is(f.preflights(), 1);
});

for (const ErrorType of [
  CopilotSelectedSourcesProcessing,
  CopilotSelectedSourcesFailed,
  CopilotSelectedSourcesLimitExceeded,
  Error,
]) {
  test(`${ErrorType.name} does not trigger fallback`, async t => {
    const error = new ErrorType();
    const f = orchestratorFixture(error);
    const caught = await t.throwsAsync(
      f.orchestrator.streamText('user', 'session', {})
    );
    t.is(caught, error);
    t.deepEqual(f.calls, []);
  });
}

test('mixed artifact selections, disabled reading, and image generation do not use Page fallback', async t => {
  const error = new CopilotSelectedSourcesUnavailable();
  const f = orchestratorFixture(error);
  f.scope.requiredArtifactIds.push('file');
  t.is(
    await t.throwsAsync(f.orchestrator.streamText('user', 'session', {})),
    error
  );
  f.scope.requiredArtifactIds = [];
  t.is(
    await t.throwsAsync(f.orchestrator.streamImages('user', 'session', {})),
    error
  );
  t.is(
    await t.throwsAsync(
      f.orchestrator.streamText('user', 'session', {
        toolsConfig: JSON.stringify({ readingDocs: false }),
      })
    ),
    error
  );
  t.deepEqual(f.calls, []);
});

test.serial(
  'file opt-in uses the authorized file route for stream-object and keeps bytes out of diagnostics',
  async t => {
    const before = process.env.AFFINE_CLAUDE_FILE_PROFILES;
    process.env.AFFINE_CLAUDE_FILE_PROFILES = '{"workspace":"file-profile"}';
    try {
      const f = orchestratorFixture(new CopilotSelectedSourcesUnavailable());
      f.scope.requiredArtifactIds.push('file');
      const result = await f.orchestrator.streamObject('user', 'session', {
        messageId: 'message',
      });
      for await (const _ of result.stream) {
        /* drain */
      }
      t.is((f.routes[0] as unknown[])[0], 'chat.default');
      t.deepEqual((f.routes[0] as unknown[])[1], {
        profileId: 'file-profile',
        modelId: 'claude-haiku-5-5',
      });
      t.is(f.runtimeMessages[0][0].content, 'Selected file');
      t.false(JSON.stringify(result.finalMessage).includes('Selected file'));
      t.true(
        f.runtimeMessages[0].some(m =>
          m.content.includes('Synthetic document content')
        )
      );
      await t.throwsAsync(
        f.orchestrator.streamObject('user', 'session', {
          profileId: 'another-profile',
          modelId: 'other',
          messageId: 'message',
        })
      );
      await t.throwsAsync(
        f.orchestrator.streamObject('user', 'session', {
          reasoning: 'true',
          messageId: 'message',
        }),
        { message: /Turn off/ }
      );
      await t.throwsAsync(
        f.orchestrator.streamObject('user', 'session', {
          webSearch: 'true',
          messageId: 'message',
        }),
        { message: /Turn off/ }
      );
    } finally {
      if (before === undefined) delete process.env.AFFINE_CLAUDE_FILE_PROFILES;
      else process.env.AFFINE_CLAUDE_FILE_PROFILES = before;
    }
  }
);
