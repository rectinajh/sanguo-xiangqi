import { describe, it, expect } from "vitest";
import { buildNeighborSet } from "../src/components/cyberfly/neighborGraph";

const synapses = [
  { pre: 1, post: 2, weight: 1 },
  { pre: 2, post: 3, weight: 2 },
  { pre: 3, post: 4, weight: 1 },
  { pre: 1, post: 5, weight: 3 },
  { pre: 10, post: 11, weight: 1 },
];

describe("buildNeighborSet", () => {
  it("returns center + 1-hop neighbors and connecting edge indices", () => {
    const { nodeIds, edgeIndices } = buildNeighborSet(synapses, 1, 1);
    expect(nodeIds.has(1)).toBe(true);
    expect(nodeIds.has(2)).toBe(true);
    expect(nodeIds.has(5)).toBe(true);
    expect(nodeIds.has(3)).toBe(false);
    expect(edgeIndices.sort()).toEqual([0, 3]);
  });

  it("treats edges as undirected for neighborhood", () => {
    const { nodeIds, edgeIndices } = buildNeighborSet(synapses, 2, 1);
    expect([...nodeIds].sort()).toEqual([1, 2, 3]);
    expect(edgeIndices.sort()).toEqual([0, 1]);
  });

  it("supports hops=2", () => {
    const { nodeIds } = buildNeighborSet(synapses, 1, 2);
    expect(nodeIds.has(3)).toBe(true);
    expect(nodeIds.has(4)).toBe(false);
  });

  it("returns only the center when isolated", () => {
    const { nodeIds, edgeIndices } = buildNeighborSet(synapses, 99, 1);
    expect([...nodeIds]).toEqual([99]);
    expect(edgeIndices).toEqual([]);
  });
});
