import { BASE_FEE, DIST_UNIT, CAPTURE_PENALTY_PER_POINT } from "./constants.js";
import { Piece, PIECE_MULT_BPS, PIECE_POINTS } from "./pieces.js";

export type Coord = { x: number; y: number };

export function chebyshev(from: Coord, to: Coord): number {
  return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
}

/** moveFee = (baseFee + distance * distUnit) * pieceMult */
export function computeMoveFee(piece: Piece, from: Coord, to: Coord): bigint {
  if (piece === Piece.Empty) return 0n;
  const dist = BigInt(chebyshev(from, to));
  const raw = BASE_FEE + dist * DIST_UNIT;
  const bps = BigInt(PIECE_MULT_BPS[piece]);
  return (raw * bps) / 1000n;
}

export function capturePenalty(piece: Piece): bigint {
  return BigInt(PIECE_POINTS[piece]) * CAPTURE_PENALTY_PER_POINT;
}

export function formatMon(wei: bigint, digits = 3): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = v % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, digits);
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
}
