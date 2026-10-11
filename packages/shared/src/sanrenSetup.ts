import { Piece } from "./pieces.js";
import { SANREN_MAP, type SanrenMap } from "./sanrenMap.js";

export interface MapPiece {
  node: number;
  /** seat == camp: 0 red, 1 black, 2 green */
  seat: number;
  piece: Piece;
}

const BACK: Piece[] = [
  Piece.Chariot, Piece.Horse, Piece.Elephant, Piece.Advisor, Piece.General,
  Piece.Advisor, Piece.Elephant, Piece.Horse, Piece.Chariot,
];

/** Look up the node at camp-local (f, r), including shared corner points. */
export function campNode(map: SanrenMap, camp: number, f: number, r: number): number {
  const n = map.nodes.find(
    (n) => (n.camp === camp && n.f === f && n.r === r) || n.alias.some((a) => a.camp === camp && a.f === f && a.r === r),
  );
  if (!n) throw new Error(`no node ${camp}:${f}:${r}`);
  return n.id;
}

export function initialSanrenPieces(map: SanrenMap = SANREN_MAP): MapPiece[] {
  const out: MapPiece[] = [];
  for (const seat of [0, 1, 2]) {
    BACK.forEach((piece, f) => out.push({ node: campNode(map, seat, f, 0), seat, piece }));
    for (const f of [1, 7]) out.push({ node: campNode(map, seat, f, 2), seat, piece: Piece.Cannon });
    for (const f of [1, 2, 4, 6, 7]) out.push({ node: campNode(map, seat, f, 3), seat, piece: Piece.Soldier });
  }
  return out;
}

const GENERAL_ZH = ["帅", "将", "王"];
const SOLDIER_ZH = ["兵", "卒", "丁"];
const OTHER_ZH: Partial<Record<Piece, string>> = {
  [Piece.Advisor]: "士",
  [Piece.Elephant]: "象",
  [Piece.Horse]: "马",
  [Piece.Chariot]: "车",
  [Piece.Cannon]: "炮",
};

export function sanrenPieceLabel(piece: Piece, seat: number): string {
  if (piece === Piece.General) return GENERAL_ZH[seat];
  if (piece === Piece.Soldier) return SOLDIER_ZH[seat];
  return OTHER_ZH[piece] ?? "";
}
