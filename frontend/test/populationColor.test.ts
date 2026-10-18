import { describe, it, expect } from "vitest";
import { populationColor, groupFromNeuron } from "../src/components/cyberfly/populationColor";

describe("populationColor", () => {
  it("maps known groups", () => {
    expect(populationColor("P1")).toBe("#e6b84d");
    expect(populationColor("DN")).toBe("#e85d4c");
    expect(populationColor("GABA")).toBe("#3db8c8");
    expect(populationColor("other")).toBe("#5a6a7e");
  });
});

describe("groupFromNeuron", () => {
  it("classifies by type / nt", () => {
    expect(groupFromNeuron("P1a", "ach")).toBe("P1");
    expect(groupFromNeuron("DNa02", "ach")).toBe("DN");
    expect(groupFromNeuron("foo", "gaba")).toBe("GABA");
    expect(groupFromNeuron("x", "ach")).toBe("other");
  });
});
