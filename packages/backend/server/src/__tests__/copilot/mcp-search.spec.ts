import test from 'ava';

import type { Config } from '../../base';
import type { DocReader, DocWriter } from '../../core/doc';
import type { PermissionAccess } from '../../core/permission';
import type { Models } from '../../models';
import { WorkspaceMcpProvider } from '../../plugins/copilot/mcp/provider';
import { DocumentRetrievalService } from '../../plugins/copilot/retrieval/document';
import type { IndexerService } from '../../plugins/indexer/service';

function fixture(
  options: {
    enabled?: boolean;
    fails?: boolean;
    denied?: boolean;
    empty?: boolean;
    permissionFails?: boolean;
  } = {}
) {
  const calls: unknown[][] = [];
  const ac = {
    user: (userId: string) => ({
      workspace: (workspaceId: string) => ({
        assert: async () => {
          if (options.denied) throw new Error('ACCESS_DENIED');
        },
        docs: async (hits: { docId: string }[], action: string) => {
          calls.push(['permission', userId, workspaceId, action]);
          if (options.permissionFails)
            throw new Error('PERMISSION_CHECK_FAILED');
          return hits.filter(hit => hit.docId !== 'private-doc');
        },
      }),
    }),
  } as unknown as PermissionAccess;
  const indexer = {
    searchDocsByKeyword: async (...args: unknown[]) => {
      calls.push(args);
      if (options.fails) throw new Error('synthetic backend outage');
      return (options.empty ? [] : ['visible-doc', 'private-doc']).map(
        docId => ({
          docId,
          title: 'Synthetic test document',
          highlight: 'Searchable passage',
          unitId: `block:${docId}`,
          blockId: docId,
          projectionVersion: 1,
          sourceHash: 'synthetic',
          visibility: 'page',
        })
      );
    },
  } as unknown as IndexerService;
  const retrieval = new DocumentRetrievalService(
    { indexer: { enabled: options.enabled ?? true } } as Config,
    ac,
    indexer,
    {
      canEmbedding: false,
      matchWorkspaceDocCandidates: async () => [],
      rerankWorkspaceDocs: async () => [],
    },
    { doc: { findMetas: async () => [] } } as unknown as Models
  );
  const provider = new WorkspaceMcpProvider(
    ac,
    {} as DocReader,
    {} as DocWriter,
    retrieval
  );
  return { provider, calls };
}

async function searchTool(provider: WorkspaceMcpProvider) {
  const server = await provider.for('test-user', 'test-workspace');
  return server.tools.find(tool => tool.name === 'doc_search')!;
}

test('keyword-only MCP search works without embeddings and filters unreadable docs', async t => {
  const { provider, calls } = fixture();
  const tool = await searchTool(provider);
  const result = await tool.execute(
    { query: '  searchable  ', doc_ids: ['visible-doc'], limit: 2 },
    { signal: new AbortController().signal }
  );
  t.falsy(result.isError);
  const body = JSON.parse(result.content[0].text);
  t.is(body.retrieval_mode, 'lexical');
  t.is(body.degraded_reason, 'VECTOR_UNAVAILABLE');
  t.deepEqual(
    body.hits.map((hit: { doc_id: string }) => hit.doc_id),
    ['visible-doc']
  );
  t.deepEqual(calls[0], [
    'test-workspace',
    'searchable',
    { limit: 20, docIds: ['visible-doc'] },
  ]);
  t.deepEqual(calls[1], [
    'permission',
    'test-user',
    'test-workspace',
    'Doc.Read',
  ]);
});

for (const options of [{ enabled: false }, { fails: true }]) {
  test(`unavailable backends return an actionable MCP tool error: ${JSON.stringify(options)}`, async t => {
    const tool = await searchTool(fixture(options).provider);
    const result = await tool.execute(
      { query: 'test' },
      { signal: new AbortController().signal }
    );
    t.true(result.isError);
    t.regex(result.content[0].text, /SEARCH_UNAVAILABLE/);
    t.regex(result.content[0].text, /keyword indexer/);
    t.regex(result.content[0].text, /read_document/);
    t.false(result.content[0].text.includes('synthetic backend outage'));
  });
}

test('workspace authorization is enforced before exposing search tools', async t => {
  const { provider, calls } = fixture({ denied: true });
  await t.throwsAsync(searchTool(provider), { message: 'ACCESS_DENIED' });
  t.deepEqual(calls, []);
});

test('invalid search arguments and pre-aborted requests do not hit the backend', async t => {
  const { provider, calls } = fixture();
  const tool = await searchTool(provider);
  for (const args of [
    { query: '  ' },
    { query: 'test', limit: 21 },
    { query: 'test', doc_ids: Array(51).fill('doc') },
  ]) {
    t.true(
      (await tool.execute(args, { signal: new AbortController().signal }))
        .isError
    );
  }
  const abort = new AbortController();
  abort.abort();
  t.true(
    (await tool.execute({ query: 'test' }, { signal: abort.signal })).isError
  );
  t.deepEqual(calls, []);
});

test('a healthy search with no matches remains a successful empty result', async t => {
  const tool = await searchTool(fixture({ empty: true }).provider);
  const result = await tool.execute(
    { query: 'absent' },
    { signal: new AbortController().signal }
  );
  t.falsy(result.isError);
  const body = JSON.parse(result.content[0].text);
  t.is(body.retrieval_mode, 'lexical');
  t.deepEqual(body.hits, []);
});

test('unrelated failures are not mislabeled as search backend outages', async t => {
  const tool = await searchTool(fixture({ permissionFails: true }).provider);
  await t.throwsAsync(
    tool.execute({ query: 'test' }, { signal: new AbortController().signal }),
    { message: 'PERMISSION_CHECK_FAILED' }
  );
});
