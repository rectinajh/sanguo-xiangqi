import { describe, it, expect } from "vitest";
import { computeMoveFee } from "../src/fees";
import { Piece } from "../src/pieces";

describe("computeMoveFee (PRD 口播三例)", () => {
  it("卒走1格 = 0.009 MON", () => {
    expect(computeMoveFee(Piece.Soldier, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(9n * 10n ** 15n);
  });
  it("车走5格 = 0.070 MON", () => {
    expect(computeMoveFee(Piece.Chariot, { x: 0, y: 0 }, { x: 5, y: 0 })).toBe(70n * 10n ** 15n);
  });
  it("马 distance=2 = 0.030 MON", () => {
    expect(computeMoveFee(Piece.Horse, { x: 0, y: 0 }, { x: 2, y: 1 })).toBe(30n * 10n ** 15n);
  });
});
