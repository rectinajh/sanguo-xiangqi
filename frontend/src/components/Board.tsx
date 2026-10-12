import {
  BoardState,
  NODE_COUNT,
  Piece,
  Seat,
  legalMoves,
  type Coord,
  type LegalMove,
  type MapPiece,
} from "@sanguo/shared";
import { SanrenBoard } from "./SanrenBoard";

type Props = {
  board: BoardState;
  mySeat: Seat | null;
  interactive: boolean;
  selected: Coord | null;
  onSelect: (c: Coord | null) => void;
  onMove: (from: Coord, to: Coord, piece: Piece) => void;
  hoverFee: { to: Coord; fee: bigint } | null;
  onHoverLegal: (info: { to: Coord; fee: bigint } | null) => void;
  ecoTargets?: Set<string>;
};

function toPieces(board: BoardState): MapPiece[] {
  const out: MapPiece[] = [];
  for (let n = 0; n < NODE_COUNT; n++) {
    const c = board.cells[n];
    if (c.piece === Piece.Empty || c.seat === null) continue;
    out.push({ node: n, seat: c.seat, piece: c.piece });
  }
  return out;
}

/** 主棋盘：照片描图节点图，走子 Coord.x = nodeId，y = 0 */
export function Board({
  board,
  mySeat,
  interactive,
  selected,
  onSelect,
  onMove,
  onHoverLegal,
  ecoTargets,
}: Props) {
  const pieces = toPieces(board);
  const moves: LegalMove[] =
    selected && mySeat !== null && board.turn === mySeat
      ? legalMoves(board, mySeat).filter((m) => m.from.x === selected.x)
      : [];
  const legalNodes = moves.map((m) => m.to.x);
  const ecoNodes = ecoTargets
    ? [...ecoTargets].map((k) => Number(k.split(",")[0]))
    : [];
  const targets = [...new Set([...legalNodes, ...ecoNodes])];
  const feeByNode = new Map(moves.map((m) => [m.to.x, m]));

  return (
    <SanrenBoard
      pieces={pieces}
      selected={selected?.x ?? null}
      targets={targets}
      onNode={
        interactive
          ? (node) => {
              const mv = feeByNode.get(node);
              if (mv && selected) {
                onMove(selected, mv.to, board.cells[selected.x].piece);
                onSelect(null);
                onHoverLegal(null);
                return;
              }
              if (mySeat !== null && board.turn === mySeat) {
                const c = board.cells[node];
                if (c.seat === mySeat && c.piece !== Piece.Empty) {
                  onSelect({ x: node, y: 0 });
                  return;
                }
              }
              onSelect(null);
            }
          : undefined
      }
    />
  );
}
