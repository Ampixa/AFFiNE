import test from 'ava';
import * as Y from 'yjs';

import type { Config } from '../../base';
import type { DocReader, DocWriter, KanbanService } from '../../core/doc';
import type { PermissionAccess } from '../../core/permission';
import type { Models } from '../../models';
import { WorkspaceMcpProvider } from '../../plugins/copilot/mcp/provider';
import { DocumentRetrievalService } from '../../plugins/copilot/retrieval/document';
import { LocalDocumentSearch } from '../../plugins/copilot/retrieval/local-document';
import { buildDocumentSearch } from '../../plugins/copilot/tools/doc-search';
import type { IndexerService } from '../../plugins/indexer/service';

function nested(value: any): any {
  if (Array.isArray(value)) {
    const array = new Y.Array();
    array.push(value.map(nested));
    return array;
  }
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Y.AbstractType)
  ) {
    return new Y.Map(Object.entries(value).map(([key, v]) => [key, nested(v)]));
  }
  return value;
}

function page(text: string, title = 'Sample') {
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');
  for (const [id, flavour, children, props] of [
    ['page', 'page', ['note'], { title: new Y.Text(title) }],
    ['note', 'note', ['p'], { displayMode: 'both' }],
    ['p', 'paragraph', [], { text: new Y.Text(text), type: 'text' }],
  ] as const) {
    blocks.set(
      id,
      nested({
        'sys:id': id,
        'sys:flavour': `affine:${flavour}`,
        'sys:version': 1,
        'sys:children': children,
        ...Object.fromEntries(
          Object.entries(props).map(([k, v]) => [`prop:${k}`, v])
        ),
      })
    );
  }
  return doc;
}

function fixture(count = 3) {
  const root = new Y.Doc();
  const pages = new Y.Array();
  root.getMap('meta').set('pages', pages);
  pages.push(
    Array.from({ length: count }, (_, i) =>
      nested({ id: `doc-${i}`, title: 'Sample' })
    )
  );
  const docs = new Map(
    Array.from({ length: count }, (_, i) => [
      `doc-${i}`,
      page(`Amber needle ${i}`),
    ])
  );
  docs.set('workspace', root);
  const denied = new Set(['doc-1']);
  const ignored = new Set<string>();
  const limited = new Set<string>();
  const reads: string[] = [];
  const workspace = { enableAi: true, enableDocEmbedding: true };
  let denyWorkspace = false;
  let onRead = (_id: string) => {};
  const ac = {
    user: (userId: string) => ({
      workspace: (workspaceId: string) => ({
        assert: async (action: string) => {
          if (
            userId !== 'user' ||
            workspaceId !== 'workspace' ||
            action !== 'Workspace.Read' ||
            denyWorkspace
          )
            throw new Error('DENIED');
        },
        docs: async (items: { docId: string }[], action: string) => {
          if (action !== 'Doc.Read') throw new Error('WRONG_PERMISSION');
          return items.filter(doc => !denied.has(doc.docId));
        },
      }),
    }),
  } as unknown as PermissionAccess;
  const models = {
    workspace: { get: async () => workspace },
    copilotWorkspace: {
      checkIgnoredDocs: async (_ws: string, ids: string[]) =>
        ids.filter(id => ignored.has(id)),
    },
    doc: {
      findMetas: async () => [],
      getBoundedSearchUpdates: async (_ws: string, id: string) => {
        reads.push(id);
        onRead(id);
        if (limited.has(id)) return { limited: true };
        const doc = docs.get(id);
        if (!doc) return null;
        const bin = Y.encodeStateAsUpdate(doc);
        return {
          limited: false,
          updates: [bin],
          bytes: bin.length,
          timestamp: new Date(0),
        };
      },
    },
  } as unknown as Models;
  const service = new LocalDocumentSearch(ac, models);
  const search = (query = 'needle', ids?: string[], signal?: AbortSignal) =>
    service.search('user', 'workspace', query, ids, 10, signal);
  return {
    service,
    search,
    docs,
    root,
    pages,
    denied,
    ignored,
    limited,
    reads,
    models,
    ac,
    workspace,
    onRead: (fn: typeof onRead) => {
      onRead = fn;
    },
    denyWorkspace: () => {
      denyWorkspace = true;
    },
  };
}

test('real native projections return authorized bounded passages with locators', async t => {
  const f = fixture();
  const result = await f.search();
  t.is(result.retrievalMode, 'local-keyword');
  t.true(result.coverage.complete);
  t.deepEqual(
    [...new Set(result.hits.map(hit => hit.docId))],
    ['doc-0', 'doc-2']
  );
  t.false(f.reads.includes('doc-1'));
  t.is(result.hits[0].blockId, 'p');
  t.is(result.hits[0].visibility, 'both');
  t.regex(result.hits[0].excerpt, /Amber needle/);
});

test('selected scope, ignored docs, trash and orphan snapshots are excluded', async t => {
  const f = fixture();
  (f.pages.get(0) as Y.Map<unknown>).set('trash', true);
  f.docs.set('orphan', page('needle'));
  f.ignored.add('doc-2');
  const result = await f.search('needle', [
    'doc-0',
    'doc-1',
    'doc-2',
    'orphan',
    'other-workspace-doc',
  ]);
  t.deepEqual(result.hits, []);
  t.true(result.coverage.complete);
  t.deepEqual(f.reads, ['workspace', 'workspace']);
});

test('warm cache cannot leak revoked access or stale edited text', async t => {
  const f = fixture();
  t.true((await f.search('needle', ['doc-0'])).hits.length > 0);
  f.denied.add('doc-0');
  f.reads.length = 0;
  t.deepEqual((await f.search('needle', ['doc-0'])).hits, []);
  t.false(f.reads.includes('doc-0'));
  f.denied.delete('doc-0');
  f.docs.set('doc-0', page('Replacement goldfinch'));
  t.deepEqual((await f.search('needle', ['doc-0'])).hits, []);
  t.regex(
    (await f.search('goldfinch', ['doc-0'])).hits[0].excerpt,
    /goldfinch/
  );
});

test('pending Yjs edits participate in search before snapshot compaction', async t => {
  const f = fixture();
  const doc = f.docs.get('doc-0')!;
  const snapshot = Y.encodeStateAsUpdate(doc);
  const state = Y.encodeStateVector(doc);
  (
    doc.getMap<Y.Map<any>>('blocks').get('p')!.get('prop:text') as Y.Text
  ).insert(0, 'Latest goldfinch ');
  const pending = Y.encodeStateAsUpdate(doc, state);
  const original = f.models.doc.getBoundedSearchUpdates.bind(f.models.doc);
  f.models.doc.getBoundedSearchUpdates = async (ws, id) =>
    id === 'doc-0'
      ? {
          limited: false,
          updates: [Buffer.from(snapshot), Buffer.from(pending)],
          bytes: snapshot.length + pending.length,
          timestamp: new Date(1),
        }
      : original(ws, id);
  t.regex(
    (await f.search('goldfinch', ['doc-0'])).hits[0].excerpt,
    /Latest goldfinch/
  );
});

test('permission revoked during reading removes the result', async t => {
  const f = fixture();
  f.onRead(id => {
    if (id === 'doc-0') f.denied.add(id);
  });
  t.deepEqual((await f.search('needle', ['doc-0'])).hits, []);
});

test('workspace and AI opt-outs fail before document reads', async t => {
  const f = fixture();
  f.workspace.enableDocEmbedding = false;
  await t.throwsAsync(f.search(), { message: 'SEARCH_UNAVAILABLE' });
  t.deepEqual(f.reads, []);
  f.workspace.enableDocEmbedding = true;
  f.denyWorkspace();
  await t.throwsAsync(f.search(), { message: 'DENIED' });
  t.deepEqual(f.reads, []);
});

test('missing and oversized docs yield explicit incomplete coverage, not false absence', async t => {
  const f = fixture();
  f.limited.add('doc-0');
  f.docs.delete('doc-2');
  const result = await f.search();
  t.deepEqual(result.hits, []);
  t.false(result.coverage.complete);
  t.is(result.coverage.skippedDocuments, 2);
  t.regex(result.coverage.note, /Do not claim/);
});

test('root changes or missing root fail closed instead of returning deleted content', async t => {
  const f = fixture();
  f.onRead(id => {
    if (id === 'doc-0') (f.pages.get(0) as Y.Map<unknown>).set('trash', true);
  });
  await t.throwsAsync(f.search(), { message: 'SEARCH_UNAVAILABLE' });
  f.docs.delete('workspace');
  await t.throwsAsync(f.search(), { message: 'SEARCH_UNAVAILABLE' });
});

test('unicode search is literal, case normalized and preserves source script', async t => {
  const f = fixture();
  f.docs.set('doc-0', page('नमस्कार सहायता केन्द्र', 'नेपाली'));
  t.regex((await f.search('सहायता', ['doc-0'])).hits[0].excerpt, /सहायता/);
  t.true((await f.search('AMBER', ['doc-2'])).hits.length > 0);
  t.deepEqual((await f.search("' OR 1=1 --", ['doc-0'])).hits, []);
});

test('document limit is disclosed and does not permanently hide later scoped documents', async t => {
  const f = fixture(260);
  const result = await f.search();
  t.is(result.coverage.searchedDocuments, 256);
  t.false(result.coverage.complete);
  t.true(result.hits.length <= 10);
  t.true((await f.search('needle', ['doc-259'])).hits.length > 0);
});

test('invalid and cancelled queries do no IO; simultaneous scans are bounded and recover', async t => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  await t.throwsAsync(f.search('needle', undefined, abort.signal));
  await t.throwsAsync(f.search('!!!'), { message: 'INVALID_SEARCH_QUERY' });
  t.deepEqual(f.reads, []);
  const first = f.search();
  await t.throwsAsync(f.search(), { message: 'SEARCH_UNAVAILABLE' });
  await first;
  t.true((await f.search()).hits.length > 0);
});

test('both failed indexed channels use fallback and preserve coverage in Intelligence tool results', async t => {
  const f = fixture();
  f.limited.add('doc-0');
  const service = new DocumentRetrievalService(
    {
      indexer: { enabled: true },
      copilotSelfHosted: { documentSearchFallback: true },
    } as Config,
    f.ac,
    {
      searchDocsByKeyword: async () => {
        throw new Error('offline');
      },
    } as unknown as IndexerService,
    {
      canEmbedding: false,
      matchWorkspaceDocCandidates: async () => [],
      rerankWorkspaceDocs: async () => [],
    },
    f.models,
    f.service
  );
  const tool = buildDocumentSearch(service, {
    user: 'user',
    workspace: 'workspace',
  });
  const result = await tool('needle', undefined, 5);
  t.is((result as any).retrieval_mode, 'local-keyword');
  t.false((result as any).coverage.complete);
  t.true((result as any).hits.length > 0);
});

test('AI opt-outs and cancellation during a scan discard newly forbidden results', async t => {
  const f = fixture();
  await f.search();
  f.onRead(id => {
    if (id === 'doc-0') f.ignored.add(id);
  });
  t.deepEqual((await f.search('needle', ['doc-0'])).hits, []);
  f.ignored.clear();
  f.onRead(id => {
    if (id === 'doc-0') f.workspace.enableAi = false;
  });
  await t.throwsAsync(f.search(), { message: 'SEARCH_UNAVAILABLE' });
  f.workspace.enableAi = true;
  const abort = new AbortController();
  f.onRead(id => {
    if (id === 'doc-0') abort.abort();
  });
  await t.throwsAsync(f.search('needle', undefined, abort.signal));
  f.onRead(() => {});
  t.true((await f.search()).hits.length > 0);
});

test('projected text limits prevent large excerpts and report incomplete coverage', async t => {
  const f = fixture();
  f.docs.set('doc-0', page('needle '.repeat(50000)));
  const result = await f.search('needle', ['doc-0']);
  t.deepEqual(result.hits, []);
  t.false(result.coverage.complete);
  t.is(result.coverage.skippedDocuments, 1);
});

test('MCP preserves local search scope and incomplete coverage', async t => {
  const f = fixture();
  f.limited.add('doc-0');
  const retrieval = new DocumentRetrievalService(
    {
      indexer: { enabled: false },
      copilotSelfHosted: { documentSearchFallback: true },
    } as Config,
    f.ac,
    {} as IndexerService,
    {
      canEmbedding: false,
      matchWorkspaceDocCandidates: async () => [],
      rerankWorkspaceDocs: async () => [],
    },
    f.models,
    f.service
  );
  const provider = new WorkspaceMcpProvider(
    f.ac,
    {} as DocReader,
    {} as DocWriter,
    retrieval,
    {} as KanbanService
  );
  const server = await provider.for('user', 'workspace');
  const tool = server.tools.find(tool => tool.name === 'doc_search');
  t.truthy(tool);
  if (!tool) return;
  const result = await tool.execute(
    { query: 'needle', doc_ids: ['doc-0', 'doc-2'] },
    { signal: new AbortController().signal }
  );
  t.falsy(result.isError);
  const body = JSON.parse(result.content[0].text);
  t.is(body.retrieval_mode, 'local-keyword');
  t.false(body.coverage.complete);
  t.deepEqual(
    body.hits.map((hit: { doc_id: string }) => hit.doc_id),
    ['doc-2']
  );
});

test('a healthy indexed search with no hits never scans the fallback', async t => {
  const f = fixture();
  const retrieval = new DocumentRetrievalService(
    {
      indexer: { enabled: true },
      copilotSelfHosted: { documentSearchFallback: true },
    } as Config,
    f.ac,
    { searchDocsByKeyword: async () => [] } as unknown as IndexerService,
    {
      canEmbedding: false,
      matchWorkspaceDocCandidates: async () => [],
      rerankWorkspaceDocs: async () => [],
    },
    f.models,
    f.service
  );
  const result = await retrieval.search(
    { user: 'user', workspace: 'workspace' },
    'absent',
    undefined,
    10
  );
  t.deepEqual(result.hits, []);
  t.deepEqual(f.reads, []);
});

test('scan input budget stops reads when many individually bounded documents are too large to project', async t => {
  const f = fixture(30);
  const oversizedProjection = page('needle '.repeat(100000));
  for (let i = 0; i < 30; i++) f.docs.set(`doc-${i}`, oversizedProjection);
  const result = await f.search();
  t.deepEqual(result.hits, []);
  t.false(result.coverage.complete);
  t.is(result.coverage.skippedDocuments, 29);
  t.true(f.reads.filter(id => id !== 'workspace').length < 29);
});
