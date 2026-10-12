/** Piece types for simplified 3-player xiangqi */
export enum Piece {
  Empty = 0,
  General = 1, // 将/帅
  Advisor = 2, // 士
  Elephant = 3, // 象
  Horse = 4, // 马
  Chariot = 5, // 车
  Cannon = 6, // 炮
  Soldier = 7, // 卒
}

export type Seat = 0 | 1 | 2; // A B C

export const PIECE_MULT: Record<Piece, number> = {
  [Piece.Empty]: 0,
  [Piece.General]: 1.0,
  [Piece.Advisor]: 1.2,
  [Piece.Elephant]: 1.2,
  [Piece.Horse]: 1.5,
  [Piece.Chariot]: 2.0,
  [Piece.Cannon]: 1.5,
  [Piece.Soldier]: 0.6,
};

/** Multiplier in basis points for Solidity mirror (×1000) */
export const PIECE_MULT_BPS: Record<Piece, number> = {
  [Piece.Empty]: 0,
  [Piece.General]: 1000,
  [Piece.Advisor]: 1200,
  [Piece.Elephant]: 1200,
  [Piece.Horse]: 1500,
  [Piece.Chariot]: 2000,
  [Piece.Cannon]: 1500,
  [Piece.Soldier]: 600,
};

export const PIECE_POINTS: Record<Piece, number> = {
  [Piece.Empty]: 0,
  [Piece.General]: 0, // capture general = defeat, not points
  [Piece.Advisor]: 30,
  [Piece.Elephant]: 30,
  [Piece.Horse]: 50,
  [Piece.Chariot]: 100,
  [Piece.Cannon]: 50,
  [Piece.Soldier]: 10,
};

export const PIECE_LABEL_ZH: Record<Piece, string> = {
  [Piece.Empty]: "",
  [Piece.General]: "将",
  [Piece.Advisor]: "士",
  [Piece.Elephant]: "象",
  [Piece.Horse]: "马",
  [Piece.Chariot]: "车",
  [Piece.Cannon]: "炮",
  [Piece.Soldier]: "卒",
};

export const SEAT_LABEL_ZH: Record<Seat, string> = {
  0: "红营",
  1: "黑营",
  2: "绿营",
};

export const SEAT_COLOR: Record<Seat, string> = {
  0: "#e85d4c",
  1: "#1e2422",
  2: "#3db87a",
};
