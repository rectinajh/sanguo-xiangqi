// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeLib} from "./libraries/FeeLib.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @title GameTable — seats, economy, commit-reveal moves, bankruptcy, finalize
/// @notice Local MVP / Monad-ready. MON is native ether-unit mock.
contract GameTable {
    using FeeLib for uint8;

    uint256 public constant SEAT_STAKE = 1 ether;
    uint256 public constant PLAY_BALANCE_INITIAL = 2 ether;
    uint256 public constant MIN_PLAY_BALANCE_TO_START = 0.5 ether;
    uint256 public constant TIMEOUT_PENALTY = 0.03 ether;
    uint256 public constant ILLEGAL_REVEAL_PENALTY = 0.05 ether;
    uint256 public constant MAX_PLIES = 80;
    uint256 public constant DEFEAT_STAKE_SHARE_BPS = 4000;
    uint256 public constant POINT_TO_MON_RATE = 0.001 ether;
    uint8 public constant BOARD_W = 11;
    uint8 public constant BOARD_H = 11;

    enum Phase {
        Lobby,
        Playing,
        Finished
    }

    struct SeatInfo {
        address player;
        uint256 seatStake;
        uint256 playBalance;
        uint32 points;
        bool eliminated;
        bool isAi; // private until reveal; stored on-chain but UI hides
    }

    struct PendingCommit {
        bytes32 commitHash;
        uint64 commitTime;
        uint8 illegalAttempts;
    }

    struct Game {
        Phase phase;
        SeatInfo[3] seats;
        uint8 turn; // 0..2
        uint32 ply;
        uint8 aiSeat; // 0..2
        bool aiRevealed;
        bytes32 motiveLogHash;
        uint256 prizePool;
        uint256 moveFeeTreasury;
        uint256 protocolTreasury;
        uint256 orphanPoints;
        // board packed: piece in low 4 bits, seat+1 in high 4 bits; 0 = empty
        uint8[11][11] board; // [y][x]
        PendingCommit[3] commits;
        address winner;
        uint8 winnerSeat;
    }

    uint256 public nextGameId = 1;
    mapping(uint256 => Game) internal games;
    AgentRegistry public registry;
    address public owner;

    event GameCreated(uint256 indexed gameId, uint8 aiSeat);
    event Joined(uint256 indexed gameId, uint8 seat, address player, bool isAi);
    event GameStarted(uint256 indexed gameId);
    event MoveCommitted(uint256 indexed gameId, uint8 seat, bytes32 commitHash);
    event MoveFeePaid(uint256 indexed gameId, uint8 seat, uint256 moveFee, uint256 playBalanceAfter);
    event PlayBalanceDeposited(uint256 indexed gameId, uint8 seat, uint256 amount, uint256 playBalanceAfter);
    event MoveRevealed(
        uint256 indexed gameId,
        uint8 seat,
        uint8 fromX,
        uint8 fromY,
        uint8 toX,
        uint8 toY,
        uint8 piece
    );
    event CaptureSettled(
        uint256 indexed gameId,
        uint8 attacker,
        uint8 victim,
        uint8 piece,
        uint32 pointsDelta,
        uint256 penalty
    );
    event PointsSeized(uint256 indexed gameId, uint8 killer, uint8 defeated, uint32 points);
    event SeatBankrupt(uint256 indexed gameId, uint8 seat, uint8 killerOr255);
    event SeatEliminated(uint256 indexed gameId, uint8 seat, uint8 killer);
    event AiRevealed(uint256 indexed gameId, uint8 seat, bytes32 motiveLogHash);
    event GameFinalized(uint256 indexed gameId, uint8 winnerSeat);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    constructor(address registry_) {
        owner = msg.sender;
        registry = AgentRegistry(registry_);
    }

    function createGame(uint8 aiSeat) external returns (uint256 gameId) {
        require(aiSeat < 3, "ai seat");
        gameId = nextGameId++;
        Game storage g = games[gameId];
        g.phase = Phase.Lobby;
        g.aiSeat = aiSeat;
        g.winnerSeat = 255;
        _setupInitialBoard(g);
        emit GameCreated(gameId, aiSeat);
    }

    function join(uint256 gameId, uint8 seat) external payable {
        Game storage g = games[gameId];
        require(g.phase == Phase.Lobby, "lobby");
        require(seat < 3, "seat");
        require(g.seats[seat].player == address(0), "taken");
        require(msg.value >= SEAT_STAKE + PLAY_BALANCE_INITIAL, "value");
        g.seats[seat].player = msg.sender;
        g.seats[seat].seatStake = SEAT_STAKE;
        g.seats[seat].playBalance = PLAY_BALANCE_INITIAL;
        g.seats[seat].points = 0;
        g.seats[seat].isAi = (seat == g.aiSeat);
        // excess → playBalance buffer
        if (msg.value > SEAT_STAKE + PLAY_BALANCE_INITIAL) {
            g.seats[seat].playBalance += msg.value - (SEAT_STAKE + PLAY_BALANCE_INITIAL);
        }
        emit Joined(gameId, seat, msg.sender, g.seats[seat].isAi);

        if (
            g.seats[0].player != address(0) && g.seats[1].player != address(0)
                && g.seats[2].player != address(0)
        ) {
            require(
                g.seats[0].playBalance >= MIN_PLAY_BALANCE_TO_START
                    && g.seats[1].playBalance >= MIN_PLAY_BALANCE_TO_START
                    && g.seats[2].playBalance >= MIN_PLAY_BALANCE_TO_START,
                "min play"
            );
            g.phase = Phase.Playing;
            g.turn = 0;
            emit GameStarted(gameId);
        }
    }

    function getSeat(uint256 gameId, uint8 seat)
        external
        view
        returns (address player, uint256 seatStake, uint256 playBalance, uint32 points, bool eliminated)
    {
        SeatInfo storage s = games[gameId].seats[seat];
        return (s.player, s.seatStake, s.playBalance, s.points, s.eliminated);
    }

    function getGameMeta(uint256 gameId)
        external
        view
        returns (Phase phase, uint8 turn, uint32 ply, bool aiRevealed, uint8 winnerSeat, uint256 prizePool)
    {
        Game storage g = games[gameId];
        return (g.phase, g.turn, g.ply, g.aiRevealed, g.winnerSeat, g.prizePool);
    }

    /// @dev AI seat hidden until reveal — only owner/demo can peek for harness
    function peekAiSeat(uint256 gameId) external view onlyOwner returns (uint8) {
        return games[gameId].aiSeat;
    }

    function cell(uint256 gameId, uint8 x, uint8 y) external view returns (uint8 piece, uint8 seatOr255) {
        uint8 packed = games[gameId].board[y][x];
        if (packed == 0) return (0, 255);
        return (packed & 0x0f, (packed >> 4) - 1);
    }

    function previewMoveFee(uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1)
        external
        pure
        returns (uint256)
    {
        return FeeLib.moveFee(piece, x0, y0, x1, y1);
    }

    function commitMove(uint256 gameId, bytes32 commitHash) external {
        Game storage g = games[gameId];
        require(g.phase == Phase.Playing, "playing");
        uint8 seat = g.turn;
        require(g.seats[seat].player == msg.sender, "turn");
        require(!g.seats[seat].eliminated, "out");
        require(g.commits[seat].commitHash == bytes32(0), "pending");
        g.commits[seat].commitHash = commitHash;
        g.commits[seat].commitTime = uint64(block.timestamp);
        g.commits[seat].illegalAttempts = 0;
        emit MoveCommitted(gameId, seat, commitHash);
    }

    function revealMove(
        uint256 gameId,
        uint8 fromX,
        uint8 fromY,
        uint8 toX,
        uint8 toY,
        uint8 piece,
        bytes32 salt
    ) external {
        Game storage g = games[gameId];
        require(g.phase == Phase.Playing, "playing");
        uint8 seat = g.turn;
        require(g.seats[seat].player == msg.sender, "turn");
        PendingCommit storage pc = g.commits[seat];
        require(pc.commitHash != bytes32(0), "no commit");

        bytes32 expected = keccak256(abi.encode(seat, fromX, fromY, toX, toY, piece, salt));
        if (expected != pc.commitHash) {
            _penalizeIllegal(g, gameId, seat);
            return;
        }

        // Board ownership check
        (uint8 boardPiece, uint8 boardSeat) = _unpack(g.board[fromY][fromX]);
        require(boardPiece == piece && boardSeat == seat, "piece");
        require(fromX < BOARD_W && fromY < BOARD_H && toX < BOARD_W && toY < BOARD_H, "bounds");
        require(!(fromX == toX && fromY == toY), "same");

        (uint8 dstPiece, uint8 dstSeat) = _unpack(g.board[toY][toX]);
        require(dstSeat != seat, "friendly");

        // Simplified on-chain legality: orthogonal/diagonal constraints by piece family
        require(_basicLegal(piece, fromX, fromY, toX, toY, dstPiece != 0), "illegal geom");

        uint256 fee = FeeLib.moveFee(piece, fromX, fromY, toX, toY);
        require(g.seats[seat].playBalance >= fee, "fee");
        g.seats[seat].playBalance -= fee;
        g.moveFeeTreasury += fee;
        emit MoveFeePaid(gameId, seat, fee, g.seats[seat].playBalance);

        // Apply move
        g.board[fromY][fromX] = 0;
        g.board[toY][toX] = _pack(piece, seat);
        emit MoveRevealed(gameId, seat, fromX, fromY, toX, toY, piece);

        if (dstPiece != 0 && dstSeat < 3) {
            _settleCapture(g, gameId, seat, dstSeat, dstPiece);
        }

        delete g.commits[seat];
        g.ply += 1;

        _checkBankruptcy(g, gameId, seat);
        if (g.phase == Phase.Playing) {
            _advanceTurn(g);
            _checkBankruptcy(g, gameId, g.turn);
        }
        if (g.ply >= MAX_PLIES && g.phase == Phase.Playing) {
            _endByPoints(g, gameId);
        }
    }


    /// @notice Human whale top-up: add MON to playBalance mid-game. AI MUST NOT call this (UI + off-chain policy).
    function depositPlayBalance(uint256 gameId, uint8 seat) external payable {
        Game storage g = games[gameId];
        require(g.phase == Phase.Playing, "playing");
        require(seat < 3, "seat");
        require(g.seats[seat].player == msg.sender, "not you");
        require(!g.seats[seat].eliminated, "out");
        require(!g.seats[seat].isAi, "ai no topup");
        require(msg.value > 0, "value");
        g.seats[seat].playBalance += msg.value;
        emit PlayBalanceDeposited(gameId, seat, msg.value, g.seats[seat].playBalance);
    }

    /// @dev Demo/director: drain playBalance to force bankruptcy path
    function directorDrain(uint256 gameId, uint8 seat, uint256 amount) external onlyOwner {
        Game storage g = games[gameId];
        require(seat < 3, "seat");
        if (amount >= g.seats[seat].playBalance) {
            g.seats[seat].playBalance = 0;
        } else {
            g.seats[seat].playBalance -= amount;
        }
        _checkBankruptcy(g, gameId, seat);
    }

    function finalizeGame(uint256 gameId, bytes32 motiveLogHash) external {
        Game storage g = games[gameId];
        require(g.phase == Phase.Finished || _aliveCount(g) <= 1 || g.ply >= MAX_PLIES, "not done");
        if (g.phase != Phase.Finished) {
            if (_aliveCount(g) == 1) {
                for (uint8 i = 0; i < 3; i++) {
                    if (!g.seats[i].eliminated) {
                        g.winnerSeat = i;
                        g.winner = g.seats[i].player;
                    }
                }
            } else {
                _endByPoints(g, gameId);
            }
            g.phase = Phase.Finished;
        }

        if (!g.aiRevealed) {
            g.aiRevealed = true;
            g.motiveLogHash = motiveLogHash;
            emit AiRevealed(gameId, g.aiSeat, motiveLogHash);
        }

        _payout(g, gameId);

        address ai = g.seats[g.aiSeat].player;
        bool aiWon = (g.winnerSeat == g.aiSeat);
        registry.recordGameResult(ai, gameId, aiWon, false, 0);

        emit GameFinalized(gameId, g.winnerSeat);
    }

    function revealAiOnly(uint256 gameId, bytes32 motiveLogHash) external {
        Game storage g = games[gameId];
        require(g.phase == Phase.Finished || msg.sender == owner, "phase");
        require(!g.aiRevealed, "done");
        g.aiRevealed = true;
        g.motiveLogHash = motiveLogHash;
        emit AiRevealed(gameId, g.aiSeat, motiveLogHash);
    }

    // —— internal —— //

    function _penalizeIllegal(Game storage g, uint256 gameId, uint8 seat) internal {
        uint256 pen = ILLEGAL_REVEAL_PENALTY;
        if (g.seats[seat].playBalance < pen) pen = g.seats[seat].playBalance;
        g.seats[seat].playBalance -= pen;
        g.protocolTreasury += pen;
        g.commits[seat].illegalAttempts += 1;
        if (g.commits[seat].illegalAttempts >= 2) {
            delete g.commits[seat];
            _advanceTurn(g);
        }
        _checkBankruptcy(g, gameId, seat);
    }

    function _settleCapture(Game storage g, uint256 gameId, uint8 attacker, uint8 victim, uint8 piece)
        internal
    {
        if (piece == 1) {
            // general captured → defeat
            _defeat(g, gameId, attacker, victim);
            return;
        }
        uint32 pts = FeeLib.piecePoints(piece);
        g.seats[attacker].points += pts;
        uint32 loss = pts / 2;
        if (g.seats[victim].points >= loss) g.seats[victim].points -= loss;
        else g.seats[victim].points = 0;

        uint256 penalty = FeeLib.capturePenalty(piece);
        if (g.seats[victim].playBalance < penalty) penalty = g.seats[victim].playBalance;
        g.seats[victim].playBalance -= penalty;
        g.protocolTreasury += penalty;

        emit CaptureSettled(gameId, attacker, victim, piece, pts, penalty);
        _checkBankruptcy(g, gameId, victim);
    }

    function _defeat(Game storage g, uint256 gameId, uint8 killer, uint8 defeated) internal {
        uint32 seized = g.seats[defeated].points;
        g.seats[killer].points += seized;
        g.seats[defeated].points = 0;
        emit PointsSeized(gameId, killer, defeated, seized);

        uint256 stake = g.seats[defeated].seatStake;
        uint256 toKiller = (stake * DEFEAT_STAKE_SHARE_BPS) / 10000;
        uint256 toPool = stake - toKiller;
        g.seats[killer].playBalance += toKiller;
        g.prizePool += toPool;
        g.seats[defeated].seatStake = 0;
        g.seats[defeated].eliminated = true;
        emit SeatEliminated(gameId, defeated, killer);

        if (_aliveCount(g) == 1) {
            g.phase = Phase.Finished;
            g.winnerSeat = killer;
            g.winner = g.seats[killer].player;
        }
    }

    function _checkBankruptcy(Game storage g, uint256 gameId, uint8 seat) internal {
        if (g.seats[seat].eliminated || g.phase != Phase.Playing) return;
        // MVP: bankrupt if playBalance < BASE_FEE * 0.6 (cheapest soldier step dist 1 ≈ 0.009)
        uint256 minFee = FeeLib.moveFee(7, 0, 0, 1, 0); // soldier 1 step
        if (g.seats[seat].playBalance < minFee) {
            g.seats[seat].eliminated = true;
            // orphan points
            g.orphanPoints += g.seats[seat].points;
            g.seats[seat].points = 0;
            // stake → prize pool
            g.prizePool += g.seats[seat].seatStake;
            g.seats[seat].seatStake = 0;
            emit SeatBankrupt(gameId, seat, 255);
            if (_aliveCount(g) == 1) {
                for (uint8 i = 0; i < 3; i++) {
                    if (!g.seats[i].eliminated) {
                        g.phase = Phase.Finished;
                        g.winnerSeat = i;
                        g.winner = g.seats[i].player;
                    }
                }
            } else if (g.turn == seat) {
                _advanceTurn(g);
            }
        }
    }

    function _advanceTurn(Game storage g) internal {
        for (uint8 i = 0; i < 3; i++) {
            g.turn = (g.turn + 1) % 3;
            if (!g.seats[g.turn].eliminated) return;
        }
    }

    function _aliveCount(Game storage g) internal view returns (uint8 n) {
        for (uint8 i = 0; i < 3; i++) if (!g.seats[i].eliminated && g.seats[i].player != address(0)) n++;
    }

    function _endByPoints(Game storage g, uint256 gameId) internal {
        uint8 best = 0;
        uint32 bestPts = 0;
        for (uint8 i = 0; i < 3; i++) {
            if (g.seats[i].eliminated) continue;
            if (g.seats[i].points >= bestPts) {
                bestPts = g.seats[i].points;
                best = i;
            }
        }
        g.phase = Phase.Finished;
        g.winnerSeat = best;
        g.winner = g.seats[best].player;
        gameId; // silence
    }

    function _payout(Game storage g, uint256 gameId) internal {
        // Convert orphan points into prize pool
        g.prizePool += uint256(g.orphanPoints) * POINT_TO_MON_RATE;
        g.orphanPoints = 0;

        uint256 pool = g.prizePool + g.moveFeeTreasury;
        g.prizePool = 0;
        g.moveFeeTreasury = 0;

        if (g.winnerSeat < 3) {
            uint256 toWinner = (pool * 7000) / 10000;
            uint256 toSecond = (pool * 2000) / 10000;
            uint256 toProto = pool - toWinner - toSecond;
            g.protocolTreasury += toProto;

            address w = g.seats[g.winnerSeat].player;
            uint256 refundStake = g.seats[g.winnerSeat].seatStake;
            g.seats[g.winnerSeat].seatStake = 0;
            uint256 refundPlay = g.seats[g.winnerSeat].playBalance;
            g.seats[g.winnerSeat].playBalance = 0;

            // find second by points
            uint8 second = 255;
            uint32 secondPts = 0;
            for (uint8 i = 0; i < 3; i++) {
                if (i == g.winnerSeat) continue;
                if (g.seats[i].points >= secondPts) {
                    secondPts = g.seats[i].points;
                    second = i;
                }
            }

            _pay(w, toWinner + refundStake + refundPlay);
            if (second < 3) {
                uint256 sp = g.seats[second].playBalance;
                g.seats[second].playBalance = 0;
                _pay(g.seats[second].player, toSecond + sp);
            }
            // others refund remaining play
            for (uint8 i = 0; i < 3; i++) {
                if (i == g.winnerSeat || i == second) continue;
                uint256 rem = g.seats[i].playBalance;
                g.seats[i].playBalance = 0;
                if (rem > 0) _pay(g.seats[i].player, rem);
            }
        }
        gameId;
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "pay");
    }

    function _pack(uint8 piece, uint8 seat) internal pure returns (uint8) {
        return piece | ((seat + 1) << 4);
    }

    function _unpack(uint8 packed) internal pure returns (uint8 piece, uint8 seat) {
        if (packed == 0) return (0, 255);
        piece = packed & 0x0f;
        seat = (packed >> 4) - 1;
    }

    function _basicLegal(uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1, bool capturing)
        internal
        pure
        returns (bool)
    {
        uint256 dx = x0 > x1 ? x0 - x1 : x1 - x0;
        uint256 dy = y0 > y1 ? y0 - y1 : y1 - y0;
        if (piece == 1 || piece == 7) {
            // general / soldier: ortho 1
            return (dx + dy == 1);
        }
        if (piece == 2) return (dx == 1 && dy == 1);
        if (piece == 3) return (dx == 2 && dy == 2);
        if (piece == 4) return ((dx == 2 && dy == 1) || (dx == 1 && dy == 2));
        if (piece == 5 || piece == 6) {
            // chariot/cannon: rook-like geom (path checked off-chain for MVP)
            return (dx == 0 || dy == 0) && (dx + dy > 0);
        }
        capturing;
        return false;
    }

    function _setupInitialBoard(Game storage g) internal {
        // Seat 0 bottom
        _put(g, 5, 10, 1, 0);
        _put(g, 4, 10, 2, 0);
        _put(g, 6, 10, 3, 0);
        _put(g, 3, 10, 4, 0);
        _put(g, 7, 10, 5, 0);
        _put(g, 5, 8, 6, 0);
        _put(g, 3, 7, 7, 0);
        _put(g, 5, 7, 7, 0);
        _put(g, 7, 7, 7, 0);
        // Seat 1
        _put(g, 0, 0, 1, 1);
        _put(g, 1, 0, 2, 1);
        _put(g, 0, 1, 3, 1);
        _put(g, 2, 0, 4, 1);
        _put(g, 0, 2, 5, 1);
        _put(g, 2, 2, 6, 1);
        _put(g, 3, 1, 7, 1);
        _put(g, 3, 3, 7, 1);
        _put(g, 1, 3, 7, 1);
        // Seat 2
        _put(g, 10, 0, 1, 2);
        _put(g, 9, 0, 2, 2);
        _put(g, 10, 1, 3, 2);
        _put(g, 8, 0, 4, 2);
        _put(g, 10, 2, 5, 2);
        _put(g, 8, 2, 6, 2);
        _put(g, 7, 1, 7, 2);
        _put(g, 7, 3, 7, 2);
        _put(g, 9, 3, 7, 2);
    }

    function _put(Game storage g, uint8 x, uint8 y, uint8 piece, uint8 seat) internal {
        g.board[y][x] = _pack(piece, seat);
    }

    receive() external payable {}
}
