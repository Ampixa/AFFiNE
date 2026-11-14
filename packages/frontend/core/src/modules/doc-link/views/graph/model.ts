export type GraphDoc = {
  id: string;
  title: string;
  group?: string;
  status?: string;
  updated?: string;
  summary?: string;
};
export type GraphEdge = { source: string; target: string };
export function normalizeGraph(
  docs: GraphDoc[],
  edges: GraphEdge[],
  limit = 200
) {
  const nodes = [...new Map(docs.map(doc => [doc.id, doc])).values()].slice(
    0,
    limit
  );
  const ids = new Set(nodes.map(node => node.id));
  const seen = new Set<string>();
  const links = edges.filter(edge => {
    const key = JSON.stringify([edge.source, edge.target]);
    if (
      edge.source === edge.target ||
      !ids.has(edge.source) ||
      !ids.has(edge.target) ||
      seen.has(key)
    )
      return false;
    seen.add(key);
    return true;
  });
  return {
    nodes,
    links,
    truncated: new Set(docs.map(doc => doc.id)).size > nodes.length,
  };
}
export function neighborhood(id: string, edges: GraphEdge[]) {
  return new Set([
    id,
    ...edges.flatMap(edge =>
      edge.source === id
        ? [edge.target]
        : edge.target === id
          ? [edge.source]
          : []
    ),
  ]);
}

/** Hubs are explicit navigation documents, not inferred write/access parents.
 * Workspaces without named hubs use documents with no incoming indexed links.
 * A cycle-only graph falls back to all nodes so the default never hides everything.
 */
export function graphOverview(nodes: GraphDoc[], links: GraphEdge[]) {
  const hubs = nodes.filter(node =>
    /(?:^|[—–-]\s+).*\bhub$/i.test(node.title.trim())
  );
  if (hubs.length)
    return { ids: new Set(hubs.map(n => n.id)), label: 'Project hubs' };
  const incoming = new Set(links.map(edge => edge.target));
  const roots = nodes.filter(node => !incoming.has(node.id));
  return {
    ids: new Set((roots.length ? roots : nodes).map(n => n.id)),
    label: roots.length ? 'Entry documents' : 'All documents',
  };
}
