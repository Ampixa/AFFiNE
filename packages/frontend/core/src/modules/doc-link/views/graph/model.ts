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
