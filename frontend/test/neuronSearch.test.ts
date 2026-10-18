import { describe, it, expect } from "vitest";
import { searchNeurons } from "../src/components/cyberfly/neuronSearch";

const neurons = [
  { id: 720575940624882073, type: "P1a", nt: "ach" },
  { id: 12345, type: "DNa02", nt: "ach" },
  { id: 12346, type: "other", nt: "gaba" },
  { id: 999, type: "fru-F", nt: "glut" },
];

describe("searchNeurons", () => {
  it("matches bodyId exact", () => {
    const r = searchNeurons(neurons, "12345");
    expect(r.map((x) => x.id)).toEqual([12345]);
  });

  it("matches bodyId prefix", () => {
    const r = searchNeurons(neurons, "1234");
    expect(r.map((x) => x.id).sort()).toEqual([12345, 12346]);
  });

  it("matches type substring case-insensitively", () => {
    const r = searchNeurons(neurons, "dna");
    expect(r.map((x) => x.id)).toEqual([12345]);
  });

  it("matches nt substring", () => {
    const r = searchNeurons(neurons, "gaba");
    expect(r.map((x) => x.id)).toEqual([12346]);
  });

  it("returns empty for blank query", () => {
    expect(searchNeurons(neurons, "  ")).toEqual([]);
    expect(searchNeurons(neurons, "")).toEqual([]);
  });

  it("returns id, type, nt fields", () => {
    const r = searchNeurons(neurons, "fru");
    expect(r[0]).toEqual({ id: 999, type: "fru-F", nt: "glut" });
  });
});
