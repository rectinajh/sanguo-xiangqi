import {
  BoardState,
  Piece,
  Seat,
  PIECE_LABEL_ZH,
  legalMoves,
  formatMon,
  Coord,
  type LegalMove,
  type Cell,
} from "@sanguo/shared";

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

export function Board({
  board,
  mySeat,
  interactive,
  selected,
  onSelect,
  onMove,
  hoverFee,
  onHoverLegal,
  ecoTargets,
}: Props) {
  const moves: LegalMove[] =
    selected && mySeat !== null && board.turn === mySeat
      ? legalMoves(board, mySeat).filter(
          (m: LegalMove) => m.from.x === selected.x && m.from.y === selected.y
        )
      : [];
  const legalKey = new Set(moves.map((m: LegalMove) => `${m.to.x},${m.to.y}`));
  const feeMap = new Map<string, LegalMove>(moves.map((m: LegalMove) => [`${m.to.x},${m.to.y}`, m]));

  return (
    <div className="board-wrap">
      <div className="board-grid" role="grid" aria-label="三人棋盘">
        {board.cells.map((row: Cell[], y: number) =>
          row.map((cell: Cell, x: number) => {
            const key = `${x},${y}`;
            const isSel = selected?.x === x && selected?.y === y;
            const isLegal = legalKey.has(key);
            const mv = feeMap.get(key);
            const showFee =
              hoverFee && hoverFee.to.x === x && hoverFee.to.y === y
                ? hoverFee.fee
                : null;
            const canPick =
              interactive &&
              mySeat !== null &&
              board.turn === mySeat &&
              cell.seat === mySeat &&
              cell.piece !== Piece.Empty;

            return (
              <div
                key={key}
                className={[
                  "cell",
                  (x + y) % 2 ? "alt" : "",
                  isSel ? "selected" : "",
                  isLegal ? (mv && mv.capture !== Piece.Empty ? "capture-legal" : "legal") : "",
                  ecoTargets?.has(key) ? "eco" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  if (isLegal && selected && mv) {
                    onMove(selected, { x, y }, board.cells[selected.y][selected.x].piece);
                    onSelect(null);
                    onHoverLegal(null);
                    return;
                  }
                  if (canPick) onSelect({ x, y });
                  else onSelect(null);
                }}
                onMouseEnter={() => {
                  if (isLegal && mv) onHoverLegal({ to: { x, y }, fee: mv.fee });
                }}
                onMouseLeave={() => onHoverLegal(null)}
              >
                {showFee !== null && (
                  <span className="fee-tip">{formatMon(showFee)} MON</span>
                )}
                {cell.piece !== Piece.Empty && cell.seat !== null && (
                  <div
                    className={`piece seat${cell.seat} ${canPick ? "clickable" : ""}`}
                    title={`${PIECE_LABEL_ZH[cell.piece]}`}
                  >
                    {PIECE_LABEL_ZH[cell.piece]}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
