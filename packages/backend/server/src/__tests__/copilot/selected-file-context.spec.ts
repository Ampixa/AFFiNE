import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import test from 'ava';

import {
  CopilotSelectedSourcesLimitExceeded,
  CopilotSelectedSourcesUnavailable,
} from '../../base';
import {
  claudeFileProfile,
  FILE_BYTE_LIMIT,
  SelectedFileContext,
  withSelectedFileContext,
} from '../../plugins/copilot/runtime/selected-file-context';
import { AttachmentAdmissionHost } from '../../plugins/copilot/runtime/hosts/attachment-admission';
import type { PromptMessage } from '../../plugins/copilot/providers/types';

type Dependencies = ConstructorParameters<typeof SelectedFileContext>;
function fixture() {
  const bytes = Buffer.from('%PDF-1.4 synthetic');
  const rows = [
    {
      id: 'file',
      canonicalMediaType: 'application/pdf',
      sizeBytes: BigInt(bytes.length),
      contentHash: createHash('sha256').update(bytes).digest('base64url'),
      storageScope: 'copilot',
      storageKey: 'artifacts/workspace/hash',
      fileName: 'example.pdf',
      displayName: 'Example',
    },
  ];
  const state = {
    member: true,
    allowed: true,
    ai: true,
    indexing: true,
    bytes,
  };
  const calls: unknown[][] = [];
  const storage = {
    getObject: async (...args: unknown[]) => {
      calls.push(['read', ...args]);
      return { body: Readable.from(state.bytes) };
    },
  };
  const db = {
    workspaceMember: {
      findFirst: async (query: unknown) => {
        calls.push(['member', query]);
        return state.member ? { id: 'member' } : null;
      },
    },
    workspaceArtifact: {
      findMany: async (query: unknown) => {
        calls.push(['artifacts', query]);
        return rows;
      },
    },
  };
  const service = new SelectedFileContext(
    {
      user: () => ({ workspace: () => ({ can: async () => state.allowed }) }),
    } as unknown as Dependencies[0],
    db as unknown as Dependencies[1],
    {
      workspace: {
        get: async () => ({
          enableAi: state.ai,
          enableDocEmbedding: state.indexing,
        }),
      },
    } as unknown as Dependencies[2],
    storage as unknown as Dependencies[3]
  );
  return { service, rows, state, calls, storage, db };
}

test('authorized selected artifact uses a native capped read and includes immutable revision', async t => {
  const f = fixture();
  const result = await f.service.read('user', 'workspace', 'session', [
    'file',
    'file',
  ]);
  t.is(result.attachments?.length, 1);
  t.regex(result.content, /untrusted/);
  t.regex(result.content, new RegExp(f.rows[0].contentHash));
  t.deepEqual(
    f.calls.find(c => c[0] === 'read'),
    ['read', 'copilot', 'artifacts/workspace/hash', FILE_BYTE_LIMIT]
  );
  const query = f.calls.find(c => c[0] === 'artifacts')![1] as any;
  t.deepEqual(query.where.id, { in: ['file'] });
  t.is(query.where.workspaceId, 'workspace');
  t.deepEqual(query.where.OR[1].messages.some.message, {
    sessionId: 'session',
    session: { userId: 'user', workspaceId: 'workspace', deletedAt: null },
  });
});

for (const field of ['member', 'allowed', 'ai', 'indexing'] as const) {
  test(`revoked ${field} blocks cached/previously selected content before storage`, async t => {
    const f = fixture();
    await f.service.read('u', 'w', 's', ['file']);
    f.calls.length = 0;
    f.state[field] = false;
    await t.throwsAsync(f.service.read('u', 'w', 's', ['file']), {
      instanceOf: CopilotSelectedSourcesUnavailable,
    });
    t.false(f.calls.some(c => c[0] === 'read'));
  });
}

test('missing, unshared and deleted files cannot result in partial answers', async t => {
  const f = fixture();
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file', 'unreadable']), {
    instanceOf: CopilotSelectedSourcesUnavailable,
  });
  t.false(f.calls.some(c => c[0] === 'read'));
});

test('count, metadata size and format are checked before storage', async t => {
  const f = fixture();
  await t.throwsAsync(
    f.service.read('u', 'w', 's', ['1', '2', '3', '4', '5']),
    { instanceOf: CopilotSelectedSourcesLimitExceeded }
  );
  f.rows[0].sizeBytes = BigInt(FILE_BYTE_LIMIT + 1);
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file']), {
    instanceOf: CopilotSelectedSourcesLimitExceeded,
  });
  f.rows[0].sizeBytes = 12n;
  f.rows[0].canonicalMediaType = 'application/msword';
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file']));
  t.false(f.calls.some(c => c[0] === 'read'));
});

test('combined size is bounded even when each file fits', async t => {
  const f = fixture();
  f.rows[0].sizeBytes = 5n * 1024n * 1024n;
  f.rows.push({ ...f.rows[0], id: 'second' });
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file', 'second']), {
    instanceOf: CopilotSelectedSourcesLimitExceeded,
  });
  t.false(f.calls.some(c => c[0] === 'read'));
});

test('altered storage bytes fail hash validation', async t => {
  const f = fixture();
  f.state.bytes = Buffer.from('%PDF-1.4 tampered!');
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file']), {
    instanceOf: CopilotSelectedSourcesUnavailable,
  });
});

test('aborted reads and failures release admission slots', async t => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file'], abort.signal));
  t.is(f.calls.length, 0);
  await f.service.read('u', 'w', 's', ['file']);
  t.pass();
});

test('file prefix is stable, ephemeral and strips stale raw attachments', t => {
  const history: PromptMessage[] = [
    { role: 'system', content: 'Rules' },
    {
      role: 'user',
      content: 'Question',
      attachments: ['https://example.com/old.pdf'],
    },
  ];
  const copy = structuredClone(history);
  const context: PromptMessage = {
    role: 'user',
    content: 'Current sources',
    attachments: [{ kind: 'bytes', data: 'YQ==', mimeType: 'text/plain' }],
  };
  const first = withSelectedFileContext(history, context);
  const second = withSelectedFileContext(
    [
      ...history,
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Follow-up' },
    ],
    context
  );
  t.deepEqual(second.slice(0, first.length), first);
  t.is(first[1], context);
  t.falsy(first[2].attachments);
  t.deepEqual(history, copy);
});

test.serial(
  'file route is server opt-in, does not inherit prototype keys and fails closed on malformed config',
  t => {
    const previous = process.env.AFFINE_CLAUDE_FILE_PROFILES;
    try {
      delete process.env.AFFINE_CLAUDE_FILE_PROFILES;
      t.is(claudeFileProfile('workspace'), undefined);
      process.env.AFFINE_CLAUDE_FILE_PROFILES = '{"workspace":"profile"}';
      t.is(claudeFileProfile('workspace'), 'profile');
      t.is(claudeFileProfile('toString'), undefined);
      process.env.AFFINE_CLAUDE_FILE_PROFILES = '{"workspace":42}';
      t.throws(() => claudeFileProfile('workspace'));
      process.env.AFFINE_CLAUDE_FILE_PROFILES = '{';
      t.throws(() => claudeFileProfile('workspace'));
    } finally {
      if (previous === undefined)
        delete process.env.AFFINE_CLAUDE_FILE_PROFILES;
      else process.env.AFFINE_CLAUDE_FILE_PROFILES = previous;
    }
  }
);

test('inline admission rejects bytes over the cap and rejects foreign file IDs', async t => {
  const service = new AttachmentAdmissionHost({} as any);
  const context = { userId: 'u', workspaceId: 'w', maxBytes: 4 };
  await t.throwsAsync(
    service.admitPromptAttachment(
      {
        kind: 'bytes',
        data: Buffer.alloc(5).toString('base64'),
        mimeType: 'text/plain',
      },
      context
    )
  );
  await t.throwsAsync(
    service.admitPromptAttachment(
      {
        kind: 'data',
        data: 'नमस्कार',
        encoding: 'utf8',
        mimeType: 'text/plain',
      },
      context
    )
  );
  await t.throwsAsync(
    service.admitPromptAttachment(
      { kind: 'file_handle', fileHandle: 'file_foreign' },
      context
    )
  );
});

test('admission fetches sequentially and enforces count and cumulative bytes', async t => {
  let active = 0,
    peak = 0,
    calls = 0;
  const service = new AttachmentAdmissionHost({
    fetchRemoteAttachment: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return { data: 'YWJj', mimeType: 'text/plain' };
    },
  } as any);
  const context = {
    userId: 'u',
    workspaceId: 'w',
    maxBytes: 4,
    maxTotalBytes: 4,
    maxAttachments: 2,
  };
  await t.throwsAsync(
    service.admitPromptAttachments(
      ['https://example.com/1', 'https://example.com/2'],
      context
    )
  );
  t.is(peak, 1);
  t.is(calls, 2);
  await t.throwsAsync(service.admitPromptAttachments(['a', 'b', 'c'], context));
  t.is(calls, 2);
});

test('native artifact hash uses base64url without padding rather than hex', async t => {
  const f = fixture();
  f.rows[0].contentHash = createHash('sha256')
    .update(f.state.bytes)
    .digest('hex');
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file']), {
    instanceOf: CopilotSelectedSourcesUnavailable,
  });
});

test('third concurrent artifact reader is rejected and slots recover', async t => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const original = f.storage.getObject;
  f.storage.getObject = async (...args) => {
    await pending;
    return original(...args);
  };
  const first = f.service.read('u', 'w', 's', ['file']);
  const second = f.service.read('u', 'w', 's', ['file']);
  await t.throwsAsync(f.service.read('u', 'w', 's', ['file']), {
    message: /busy/,
  });
  release();
  await Promise.all([first, second]);
  await f.service.read('u', 'w', 's', ['file']);
  t.pass();
});

test('oversized percent-encoded data URLs are rejected before materialization', async t => {
  let fetched = false;
  const service = new AttachmentAdmissionHost({
    fetchRemoteAttachment: async () => {
      fetched = true;
    },
  } as any);
  await t.throwsAsync(
    service.admitPromptAttachment('data:text/plain,' + '%41'.repeat(5), {
      userId: 'u',
      workspaceId: 'w',
      maxBytes: 4,
    })
  );
  t.false(fetched);
});
