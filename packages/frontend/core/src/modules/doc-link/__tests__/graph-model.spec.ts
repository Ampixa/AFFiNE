import { describe, expect, test } from 'vitest';

import { folderGraph, normalizeGraph } from '../views/graph/model';

describe('folderGraph', () => {
  const rows = [
    { id: 'funding', parentId: null, type: 'folder', data: 'Funding' },
    { id: 'grants', parentId: 'funding', type: 'folder', data: 'Grants' },
    { id: 'l1', parentId: 'funding', type: 'doc', data: 'plan' },
    { id: 'l2', parentId: 'grants', type: 'doc', data: 'secret' },
    { id: 'l3', parentId: 'gone', type: 'doc', data: 'plan' },
    { id: 't1', parentId: 'funding', type: 'tag', data: 'tag-1' },
  ];

  test('folders become nodes linked to their sub-folders and docs', () => {
    const { docs, edges } = folderGraph(rows);
    expect(docs.map(d => [d.id, d.title, d.kind])).toEqual([
      ['folder:funding', 'Funding', 'folder'],
      ['folder:grants', 'Grants', 'folder'],
    ]);
    // Doc-to-sub-doc edges come from mentions and are passed in alongside.
    const graph = normalizeGraph(
      [
        ...docs,
        { id: 'plan', title: 'Plan' },
        { id: 'budget', title: 'Budget' },
      ],
      [...edges, { source: 'plan', target: 'budget' }]
    );
    expect(graph.links).toEqual([
      { source: 'folder:funding', target: 'folder:grants' },
      { source: 'folder:funding', target: 'plan' },
      { source: 'plan', target: 'budget' },
    ]);
  });
});
