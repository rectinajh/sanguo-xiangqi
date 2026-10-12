import { describe, it, expect } from "vitest";
import { computeMoveFeeBySteps } from "../src/fees";
import { Piece } from "../src/pieces";

describe("computeMoveFeeBySteps (SANREN_RULES §4)", () => {
  it("卒 1 步 = 0.009 MON", () => {
    expect(computeMoveFeeBySteps(Piece.Soldier, 1)).toBe(9n * 10n ** 15n);
  });
  it("车 5 步 = 0.070 MON", () => {
    expect(computeMoveFeeBySteps(Piece.Chariot, 5)).toBe(70n * 10n ** 15n);
  });
  it("马按 2 步 = 0.030 MON", () => {
    expect(computeMoveFeeBySteps(Piece.Horse, 2)).toBe(30n * 10n ** 15n);
  });
});
