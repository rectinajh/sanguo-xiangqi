export type SynapseEdge = { pre: number; post: number; weight?: number };

export function buildNeighborSet(
  synapses: SynapseEdge[],
  neuronId: number,
  hops = 1
): { nodeIds: Set<number>; edgeIndices: number[] } {
  const nodeIds = new Set<number>([neuronId]);
  if (hops < 1) return { nodeIds, edgeIndices: [] };

  // Adjacency: id -> list of { neighbor, edgeIndex }
  const adj = new Map<number, { neighbor: number; ei: number }[]>();
  synapses.forEach((s, ei) => {
    if (!adj.has(s.pre)) adj.set(s.pre, []);
    if (!adj.has(s.post)) adj.set(s.post, []);
    adj.get(s.pre)!.push({ neighbor: s.post, ei });
    adj.get(s.post)!.push({ neighbor: s.pre, ei });
  });

  const edgeSet = new Set<number>();
  let frontier = new Set<number>([neuronId]);

  for (let h = 0; h < hops; h++) {
    const next = new Set<number>();
    for (const id of frontier) {
      const links = adj.get(id) ?? [];
      for (const { neighbor, ei } of links) {
        if (!nodeIds.has(neighbor)) {
          nodeIds.add(neighbor);
          next.add(neighbor);
        }
        // Include edge if both ends are in the growing set (they will be)
        edgeSet.add(ei);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  // Only keep edges whose both endpoints are in nodeIds
  const edgeIndices: number[] = [];
  for (const ei of edgeSet) {
    const s = synapses[ei];
    if (s && nodeIds.has(s.pre) && nodeIds.has(s.post)) edgeIndices.push(ei);
  }
  edgeIndices.sort((a, b) => a - b);

  return { nodeIds, edgeIndices };
}
