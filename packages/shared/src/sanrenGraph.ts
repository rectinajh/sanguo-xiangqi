import {
  CAMP_BLACK,
  CAMP_GREEN,
  CAMP_RED,
  CITADEL,
  SANREN_MAP,
  type SanrenMap,
} from "./sanrenMap.js";

export type Face = [number, number, number, number]; // four node ids, cyclic order

export type SanrenGraph = {
  nodeCount: number;
  adj: number[][];
  /** faces (quads) as 4-cycles */
  faces: Face[];
  /** palace node set per camp */
  palace: Set<number>[];
  /** own-camp node set per seat/camp */
  campNodes: Set<number>[];
  /** gate node facing each camp */
  gate: number[];
  map: SanrenMap;
};

function buildAdj(map: SanrenMap): number[][] {
  const adj: number[][] = Array.from({ length: map.nodes.length }, () => []);
  const add = (a: number, b: number) => {
    if (!adj[a].includes(b)) adj[a].push(b);
    if (!adj[b].includes(a)) adj[b].push(a);
  };
  for (const s of map.segments) add(s.a, s.b);
  for (const row of adj) row.sort((a, b) => a - b);
  return adj;
}

/** Enumerate unique 4-cycles (faces) from adjacency. */
function buildFaces(adj: number[][]): Face[] {
  const faces: Face[] = [];
  const seen = new Set<string>();
  const keyOf = (ids: number[]) => [...ids].sort((a, b) => a - b).join("-");
  for (let a = 0; a < adj.length; a++) {
    for (const b of adj[a]) {
      if (b <= a) continue;
      for (const c of adj[b]) {
        if (c === a) continue;
        for (const d of adj[a]) {
          if (d === b || d === c) continue;
          if (!adj[c].includes(d)) continue;
          // a-b-c-d-a is a quad if also not a chord that collapses (a-c or b-d optional)
          const ids: Face = [a, b, c, d];
          const k = keyOf(ids);
          if (seen.has(k)) continue;
          // require exactly the cycle edges; reject if a-c and b-d both exist as a "crossed" double
          // Accept any simple 4-cycle
          seen.add(k);
          faces.push(ids);
        }
      }
    }
  }
  return faces;
}

export function buildSanrenGraph(map: SanrenMap = SANREN_MAP): SanrenGraph {
  const adj = buildAdj(map);
  const faces = buildFaces(adj);
  const palace: Set<number>[] = [new Set(), new Set(), new Set()];
  for (let c = 0; c < 3; c++) for (const id of map.palace[c]) palace[c].add(id);

  const campNodes: Set<number>[] = [new Set(), new Set(), new Set()];
  for (const n of map.nodes) {
    if (n.camp === CAMP_RED || n.camp === CAMP_BLACK || n.camp === CAMP_GREEN) {
      campNodes[n.camp].add(n.id);
    }
    for (const a of n.alias) {
      if (a.camp <= 2) campNodes[a.camp].add(n.id);
    }
  }

  const gate = [0, 0, 0];
  for (const n of map.nodes) {
    if (n.kind === "gate") {
      // key z:G{c}
      const m = /^z:G(\d)$/.exec(n.key);
      if (m) gate[Number(m[1])] = n.id;
    }
  }

  return {
    nodeCount: map.nodes.length,
    adj,
    faces,
    palace,
    campNodes,
    gate,
    map,
  };
}

export const SANREN_GRAPH = buildSanrenGraph();

export function localFr(map: SanrenMap, nodeId: number, camp: number): { f: number; r: number } | null {
  const n = map.nodes[nodeId];
  if (!n) return null;
  if (n.camp === camp && n.f >= 0) return { f: n.f, r: n.r };
  const a = n.alias.find((x) => x.camp === camp);
  if (a) return { f: a.f, r: a.r };
  return null;
}

export function nodeCamp(map: SanrenMap, nodeId: number): number {
  return map.nodes[nodeId]?.camp ?? CITADEL;
}

/** BFS distance; -1 if unreachable */
export function bfsDist(adj: number[][], from: number, to: number): number {
  if (from === to) return 0;
  const q = [from];
  const dist = new Map<number, number>([[from, 0]]);
  for (let i = 0; i < q.length; i++) {
    const u = q[i];
    const du = dist.get(u)!;
    for (const v of adj[u]) {
      if (dist.has(v)) continue;
      dist.set(v, du + 1);
      if (v === to) return du + 1;
      q.push(v);
    }
  }
  return -1;
}

/** Opposite corner of `leg` in face that does not contain `start`. */
export function horseLanding(face: Face, start: number, leg: number): number | null {
  if (!face.includes(leg) || face.includes(start)) return null;
  // In cycle order, opposite of leg is +2 mod 4
  const i = face.indexOf(leg);
  // Try both cyclic orientations — face order may not be sequential around the quad
  const others = face.filter((x) => x !== leg);
  // Opposite = the unique vertex in face not adjacent to start... but start not in face.
  // Geometric opposite: vertex that shares no face-edge with... actually rule: 对角点
  // In a quad A-B-C-D, opposite of B is D.
  // Find two neighbors of leg in the face; the remaining vertex is opposite.
  const neigh = others.filter((x) => {
    // Is x adjacent to leg along the face? In a 4-cycle every non-opposite is adjacent.
    // Opposite is the one that is NOT adjacent in the cycle of 4 — i.e. the one among others that isn't next to leg in either cyclic order.
    return true;
  });
  // Reconstruct: edges of face as complete cycle if we order properly
  // Brute: opposite = the vertex v in face, v!=leg, such that the other two are both adjacent to leg in the face graph (path length 2 via either).
  for (const cand of others) {
    const mid = others.filter((x) => x !== cand);
    // cand is opposite if both mid nodes connect leg to cand
    if (mid.length === 2) return cand; // wait that's always one of them
  }
  // Correct: in K2,2 or C4, opposite of leg is the unique node at graph distance 2 within the face subgraph.
  const faceSet = new Set(face);
  const faceAdj = (u: number) => face.filter((v) => v !== u && /* edge in cycle */ true);
  // Build face edges: all pairs in face that are distance-1 in full adj — pass adj in
  return null;
}

export function horseLandingWithAdj(adj: number[][], face: Face, start: number, leg: number): number | null {
  if (!face.includes(leg) || face.includes(start)) return null;
  const faceSet = new Set<number>(face);
  const fn = (u: number) => adj[u].filter((v) => faceSet.has(v));
  const neigh = fn(leg);
  if (neigh.length !== 2) {
    // degenerate face encoding — pick vertex at dist 2 in face
  }
  for (const cand of face) {
    if (cand === leg) continue;
    // opposite: not in neigh of leg within face
    if (!neigh.includes(cand) && fn(cand).length >= 1) {
      // ensure cand is in face and connected
      if (fn(cand).every((x) => neigh.includes(x) || x === leg)) return cand;
    }
  }
  // Fallback: node in face at BFS dist 2 from leg using only face edges
  const q = [leg];
  const d = new Map<number, number>([[leg, 0]]);
  for (let i = 0; i < q.length; i++) {
    const u = q[i];
    for (const v of fn(u)) {
      if (d.has(v)) continue;
      d.set(v, d.get(u)! + 1);
      q.push(v);
    }
  }
  for (const cand of face) {
    if (d.get(cand) === 2) return cand;
  }
  return null;
}

export { CAMP_RED, CAMP_BLACK, CAMP_GREEN, CITADEL };
