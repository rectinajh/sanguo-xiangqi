// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeLib} from "./libraries/FeeLib.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @title GameTable — seats, economy, commit-reveal moves, bankruptcy, finalize
/// @notice Local MVP / Monad-ready. MON is native ether-unit mock.
/// @dev AI seat is stored but not emitted until AiRevealed.
contract GameTable {
    using FeeLib for uint8;

    uint256 public constant SEAT_STAKE = 1 ether;
    uint256 public constant PLAY_BALANCE_INITIAL = 2 ether;
    uint256 public constant MIN_PLAY_BALANCE_TO_START = 0.5 ether;
    uint256 public constant TIMEOUT_PENALTY = 0.03 ether;
    uint256 public constant ILLEGAL_REVEAL_PENALTY = 0.05 ether;
    uint256 public constant COMMIT_REVEAL_WINDOW = 60;
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
        bool isAi; // hidden until AiRevealed; never emitted on join
    }

    struct PendingCommit {
        bytes32 commitHash;
        uint64 commitTime;
        uint8 illegalAttempts;
    }

    struct CaptureRecord {
        uint32 ply;
        uint8 attacker;
        uint8 victim;
        uint8 piece;
    }

    struct Game {
        Phase phase;
        SeatInfo[3] seats;
        uint8 turn; // 0..2
        uint32 ply;
        uint8 aiSeat; // 0..2, private until reveal
        bool aiRevealed;
        bool settled;
        bytes32 motiveLogHash;
        uint256 prizePool;
        uint256 moveFeeTreasury;
        uint256 protocolTreasury;
        uint256 orphanPoints;
        uint256[3] feesPaid;
        bool[3] slashed;
        // board packed: piece in low 4 bits, seat+1 in high 4 bits; 0 = empty
        uint8[11][11] board; // [y][x]
        PendingCommit[3] commits;
        address winner;
        uint8 winnerSeat;
    }

    uint256 public nextGameId = 1;
    mapping(uint256 => Game) internal games;
    mapping(uint256 => CaptureRecord[]) private captureLog;
    AgentRegistry public registry;
    address public owner;
    address public covenant;

    event GameCreated(uint256 indexed gameId);
    event Joined(uint256 indexed gameId, uint8 seat, address player);
    event GameStarted(uint256 indexed gameId);
    event MoveCommitted(uint256 indexed gameId, uint8 seat, bytes32 commitHash);
    event MoveFeePaid(uint256 indexed gameId, uint8 seat, uint256 moveFee, uint256 playBalanceAfter);
    event PlayBalanceDeposited(uint256 indexed gameId, uint8 seat, uint256 amount, uint256 playBalanceAfter);
    event MoveRevealed(
        uint256 indexed gameId, uint8 seat, uint8 fromX, uint8 fromY, uint8 toX, uint8 toY, uint8 piece
    );
    event CaptureSettled(
        uint256 indexed gameId, uint8 attacker, uint8 victim, uint8 piece, uint32 pointsDelta, uint256 penalty
    );
    event PointsSeized(uint256 indexed gameId, uint8 killer, uint8 defeated, uint32 points);
    event SeatBankrupt(uint256 indexed gameId, uint8 seat, uint8 killerOr255);
    event SeatEliminated(uint256 indexed gameId, uint8 seat, uint8 killer);
    event AiRevealed(uint256 indexed gameId, uint8 seat, bytes32 motiveLogHash);
    event GameFinalized(uint256 indexed gameId, uint8 winnerSeat);
    event CommitExpired(uint256 indexed gameId, uint8 seat, uint256 penalty);
    event SlashCredited(uint256 indexed gameId, uint8 victimSeat, uint8 betrayerSeat, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    constructor(address registry_) {
        owner = msg.sender;
        registry = AgentRegistry(registry_);
    }

    function setCovenant(address c) external onlyOwner {
        covenant = c;
    }

    function createGame(uint8 aiSeat) external returns (uint256 gameId) {
        require(aiSeat < 3, "ai seat");
        gameId = nextGameId++;
        Game storage g = games[gameId];
        g.phase = Phase.Lobby;
        g.aiSeat = aiSeat;
        g.winnerSeat = 255;
        _setupInitialBoard(g);
        emit GameCreated(gameId);
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
        if (msg.value > SEAT_STAKE + PLAY_BALANCE_INITIAL) {
            g.seats[seat].playBalance += msg.value - (SEAT_STAKE + PLAY_BALANCE_INITIAL);
        }
        emit Joined(gameId, seat, msg.sender);

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

    function feesPaidOf(uint256 gameId, uint8 seat) external view returns (uint256) {
        return games[gameId].feesPaid[seat];
    }

    function seatWasSlashed(uint256 gameId, uint8 seat) external view returns (bool) {
        return games[gameId].slashed[seat];
    }

    function captureCount(uint256 gameId) external view returns (uint256) {
        return captureLog[gameId].length;
    }

    function cell(uint256 gameId, uint8 x, uint8 y) external view returns (uint8 piece, uint8 seatOr255) {
        uint8 packed = games[gameId].board[y][x];
        if (packed == 0) return (0, 255);
        return (packed & 0x0f, (packed >> 4) - 1);
    }

    function previewMoveFee(uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1) external pure returns (uint256) {
        return FeeLib.moveFee(piece, x0, y0, x1, y1);
    }

    /// @notice True if attacker captured victim's advisor strictly after the covenant activated.
    function advisorBetrayal(uint256 gameId, uint8 attacker, uint8 victim, uint32 activatedPly)
        external
        view
        returns (bool)
    {
        CaptureRecord[] storage log = captureLog[gameId];
        for (uint256 i = 0; i < log.length; i++) {
            CaptureRecord storage c = log[i];
            if (c.attacker == attacker && c.victim == victim && c.piece == 2 && c.ply > activatedPly) return true;
        }
        return false;
    }

    /// @notice True if attacker captured any of victim's pieces inside the peace window, after activation.
    function peaceBetrayal(uint256 gameId, uint8 attacker, uint8 victim, uint32 activatedPly, uint32 untilPly)
        external
        view
        returns (bool)
    {
        CaptureRecord[] storage log = captureLog[gameId];
        for (uint256 i = 0; i < log.length; i++) {
            CaptureRecord storage c = log[i];
            if (c.attacker == attacker && c.victim == victim && c.ply > activatedPly && c.ply <= untilPly) return true;
        }
        return false;
    }

    /// @notice Covenant-only: move slashed bond into the victim's playBalance and flag the betrayer.
    function creditSlash(uint256 gameId, uint8 victimSeat, uint8 betrayerSeat) external payable {
        require(msg.sender == covenant, "covenant");
        require(victimSeat < 3 && betrayerSeat < 3, "seat");
        Game storage g = games[gameId];
        g.seats[victimSeat].playBalance += msg.value;
        g.slashed[betrayerSeat] = true;
        emit SlashCredited(gameId, victimSeat, betrayerSeat, msg.value);
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

        require(_isLegal(g, seat, piece, fromX, fromY, toX, toY), "illegal geom");

        (uint8 dstPiece, uint8 dstSeat) = _unpack(g.board[toY][toX]);

        uint256 fee = FeeLib.moveFee(piece, fromX, fromY, toX, toY);
        require(g.seats[seat].playBalance >= fee, "fee");
        g.seats[seat].playBalance -= fee;
        g.moveFeeTreasury += fee;
        g.feesPaid[seat] += fee;
        emit MoveFeePaid(gameId, seat, fee, g.seats[seat].playBalance);

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

    /// @notice Anyone may close a commit that sat unrevealed for COMMIT_REVEAL_WINDOW seconds.
    function expireCommit(uint256 gameId) external {
        Game storage g = games[gameId];
        require(g.phase == Phase.Playing, "playing");
        uint8 seat = g.turn;
        PendingCommit storage pc = g.commits[seat];
        require(pc.commitHash != bytes32(0), "no commit");
        require(block.timestamp >= uint256(pc.commitTime) + COMMIT_REVEAL_WINDOW, "window");

        uint256 pen = TIMEOUT_PENALTY;
        if (g.seats[seat].playBalance < pen) pen = g.seats[seat].playBalance;
        g.seats[seat].playBalance -= pen;
        g.protocolTreasury += pen;
        delete g.commits[seat];
        emit CommitExpired(gameId, seat, pen);

        _checkBankruptcy(g, gameId, seat);
        if (g.phase == Phase.Playing && !g.seats[seat].eliminated && g.turn == seat) {
            _advanceTurn(g);
        }
    }

    /// @notice Human whale top-up. AI seats revert.
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

    /// @dev Demo/director: drain playBalance to force bankruptcy path. Not used for the betrayal capture.
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
        require(!g.settled, "settled");
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
        g.settled = true;

        address ai = g.seats[g.aiSeat].player;
        bool aiWon = (g.winnerSeat == g.aiSeat);
        uint256 forcedBurn = 0;
        for (uint8 i = 0; i < 3; i++) {
            if (i != g.aiSeat) forcedBurn += g.feesPaid[i];
        }
        registry.recordGameResult(ai, gameId, aiWon, g.slashed[g.aiSeat], forcedBurn);

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

    function _settleCapture(Game storage g, uint256 gameId, uint8 attacker, uint8 victim, uint8 piece) internal {
        captureLog[gameId].push(
            CaptureRecord({ply: g.ply + 1, attacker: attacker, victim: victim, piece: piece})
        );
        if (piece == 1) {
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
        if (g.seats[seat].player == address(0)) return;
        (bool any, uint256 minFee) = _minLegalFee(g, seat);
        // No legal move, or playBalance cannot cover the cheapest one. Stake never subsidises a move.
        if (!any || g.seats[seat].playBalance < minFee) {
            g.seats[seat].eliminated = true;
            g.orphanPoints += g.seats[seat].points;
            g.seats[seat].points = 0;
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
        for (uint8 i = 0; i < 3; i++) {
            if (!g.seats[i].eliminated && g.seats[i].player != address(0)) n++;
        }
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
        gameId;
    }

    function _payout(Game storage g, uint256 gameId) internal {
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

    function _isLegal(Game storage g, uint8 seat, uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1)
        internal
        view
        returns (bool)
    {
        if (x0 >= BOARD_W || y0 >= BOARD_H || x1 >= BOARD_W || y1 >= BOARD_H) return false;
        if (x0 == x1 && y0 == y1) return false;
        (uint8 boardPiece, uint8 boardSeat) = _unpack(g.board[y0][x0]);
        if (boardPiece != piece || boardSeat != seat) return false;
        (uint8 dstPiece, uint8 dstSeat) = _unpack(g.board[y1][x1]);
        if (dstSeat == seat) return false;

        uint8 adx = x0 > x1 ? x0 - x1 : x1 - x0;
        uint8 ady = y0 > y1 ? y0 - y1 : y1 - y0;

        if (piece == 1 || piece == 7) return adx + ady == 1;
        if (piece == 2) return adx == 1 && ady == 1;
        if (piece == 3) {
            if (!(adx == 2 && ady == 2)) return false;
            return g.board[(y0 + y1) / 2][(x0 + x1) / 2] == 0;
        }
        if (piece == 4) {
            if (!((adx == 2 && ady == 1) || (adx == 1 && ady == 2))) return false;
            uint8 hx = x0;
            uint8 hy = y0;
            if (adx == 2) hx = x1 > x0 ? x0 + 1 : x0 - 1;
            else hy = y1 > y0 ? y0 + 1 : y0 - 1;
            return g.board[hy][hx] == 0;
        }
        if (piece == 5 || piece == 6) {
            if (!((adx == 0 || ady == 0) && adx + ady > 0)) return false;
            uint256 between = _countBetween(g, x0, y0, x1, y1);
            if (piece == 5) return between == 0;
            if (dstPiece == 0) return between == 0;
            return between == 1;
        }
        return false;
    }

    function _countBetween(Game storage g, uint8 x0, uint8 y0, uint8 x1, uint8 y1) internal view returns (uint256 n) {
        int256 sx = x1 > x0 ? int256(1) : (x1 < x0 ? int256(-1) : int256(0));
        int256 sy = y1 > y0 ? int256(1) : (y1 < y0 ? int256(-1) : int256(0));
        int256 x = int256(uint256(x0)) + sx;
        int256 y = int256(uint256(y0)) + sy;
        while (x != int256(uint256(x1)) || y != int256(uint256(y1))) {
            if (g.board[uint8(uint256(y))][uint8(uint256(x))] != 0) n++;
            x += sx;
            y += sy;
        }
    }

    function _minLegalFee(Game storage g, uint8 seat) internal view returns (bool any, uint256 minFee) {
        minFee = type(uint256).max;
        for (uint8 y = 0; y < BOARD_H; y++) {
            for (uint8 x = 0; x < BOARD_W; x++) {
                (uint8 piece, uint8 s) = _unpack(g.board[y][x]);
                if (piece == 0 || s != seat) continue;
                (any, minFee) = _minFromPiece(g, seat, piece, x, y, any, minFee);
            }
        }
    }

    function _minFromPiece(
        Game storage g,
        uint8 seat,
        uint8 piece,
        uint8 x,
        uint8 y,
        bool any,
        uint256 minFee
    ) internal view returns (bool, uint256) {
        if (piece == 5 || piece == 6) {
            (any, minFee) = _ray(g, seat, piece, x, y, 1, 0, any, minFee);
            (any, minFee) = _ray(g, seat, piece, x, y, -1, 0, any, minFee);
            (any, minFee) = _ray(g, seat, piece, x, y, 0, 1, any, minFee);
            (any, minFee) = _ray(g, seat, piece, x, y, 0, -1, any, minFee);
            return (any, minFee);
        }
        if (piece == 4) {
            (any, minFee) = _step(g, seat, piece, x, y, 2, 1, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, 2, -1, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -2, 1, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -2, -1, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, 1, 2, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, 1, -2, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -1, 2, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -1, -2, any, minFee);
            return (any, minFee);
        }
        if (piece == 3) {
            (any, minFee) = _step(g, seat, piece, x, y, 2, 2, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, 2, -2, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -2, 2, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -2, -2, any, minFee);
            return (any, minFee);
        }
        if (piece == 2) {
            (any, minFee) = _step(g, seat, piece, x, y, 1, 1, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, 1, -1, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -1, 1, any, minFee);
            (any, minFee) = _step(g, seat, piece, x, y, -1, -1, any, minFee);
            return (any, minFee);
        }
        (any, minFee) = _step(g, seat, piece, x, y, 1, 0, any, minFee);
        (any, minFee) = _step(g, seat, piece, x, y, -1, 0, any, minFee);
        (any, minFee) = _step(g, seat, piece, x, y, 0, 1, any, minFee);
        (any, minFee) = _step(g, seat, piece, x, y, 0, -1, any, minFee);
        return (any, minFee);
    }

    function _ray(
        Game storage g,
        uint8 seat,
        uint8 piece,
        uint8 x,
        uint8 y,
        int256 dx,
        int256 dy,
        bool any,
        uint256 minFee
    ) internal view returns (bool, uint256) {
        int256 cx = int256(uint256(x));
        int256 cy = int256(uint256(y));
        for (uint8 i = 0; i < 10; i++) {
            cx += dx;
            cy += dy;
            if (cx < 0 || cy < 0 || cx > 10 || cy > 10) break;
            (any, minFee) =
                _consider(g, seat, piece, x, y, uint8(uint256(cx)), uint8(uint256(cy)), any, minFee);
        }
        return (any, minFee);
    }

    function _step(
        Game storage g,
        uint8 seat,
        uint8 piece,
        uint8 x,
        uint8 y,
        int256 dx,
        int256 dy,
        bool any,
        uint256 minFee
    ) internal view returns (bool, uint256) {
        int256 nx = int256(uint256(x)) + dx;
        int256 ny = int256(uint256(y)) + dy;
        if (nx < 0 || ny < 0 || nx > 10 || ny > 10) return (any, minFee);
        return _consider(g, seat, piece, x, y, uint8(uint256(nx)), uint8(uint256(ny)), any, minFee);
    }

    function _consider(
        Game storage g,
        uint8 seat,
        uint8 piece,
        uint8 x,
        uint8 y,
        uint8 destX,
        uint8 destY,
        bool any,
        uint256 minFee
    ) internal view returns (bool, uint256) {
        if (!_isLegal(g, seat, piece, x, y, destX, destY)) return (any, minFee);
        uint256 fee = FeeLib.moveFee(piece, x, y, destX, destY);
        if (!any || fee < minFee) return (true, fee);
        return (any, minFee);
    }

    function _setupInitialBoard(Game storage g) internal {
        _put(g, 5, 10, 1, 0);
        _put(g, 4, 10, 2, 0);
        _put(g, 6, 10, 3, 0);
        _put(g, 3, 10, 4, 0);
        _put(g, 7, 10, 5, 0);
        _put(g, 5, 8, 6, 0);
        _put(g, 3, 7, 7, 0);
        _put(g, 5, 7, 7, 0);
        _put(g, 7, 7, 7, 0);
        _put(g, 0, 0, 1, 1);
        _put(g, 1, 0, 2, 1);
        _put(g, 0, 1, 3, 1);
        _put(g, 2, 0, 4, 1);
        _put(g, 0, 2, 5, 1);
        _put(g, 2, 2, 6, 1);
        _put(g, 3, 1, 7, 1);
        _put(g, 3, 3, 7, 1);
        _put(g, 1, 3, 7, 1);
        _put(g, 10, 0, 1, 2);
        _put(g, 9, 0, 2, 2);
        _put(g, 10, 1, 3, 2);
        // Horse shifted toward seat 0's advisor so betrayal is a legal short path.
        _put(g, 6, 9, 4, 2);
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
