export type SearchableNeuron = {
  id: number;
  type?: string;
  nt?: string;
};

export type SearchHit = {
  id: number;
  type?: string;
  nt?: string;
};

export function searchNeurons(
  neurons: SearchableNeuron[],
  query: string
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];
  for (const n of neurons) {
    const idStr = String(n.id);
    const type = (n.type ?? "").toLowerCase();
    const nt = (n.nt ?? "").toLowerCase();
    if (
      idStr === q ||
      idStr.startsWith(q) ||
      type.includes(q) ||
      nt.includes(q)
    ) {
      hits.push({ id: n.id, type: n.type, nt: n.nt });
    }
  }
  return hits;
}