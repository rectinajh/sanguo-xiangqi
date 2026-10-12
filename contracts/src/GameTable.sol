// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeLib} from "./libraries/FeeLib.sol";
import {SanrenData} from "./libraries/SanrenData.sol";
import {SanrenRules} from "./libraries/SanrenRules.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @title GameTable — seats, economy, commit-reveal moves, bankruptcy, finalize
/// @notice Local MVP / Monad-ready. MON is native ether-unit mock.
/// @dev AI seat is stored but not emitted until AiRevealed.
/// @dev Board is the photo-traced sanren graph: fromX/toX = nodeId, fromY/toY must be 0.
contract GameTable {
    using FeeLib for uint8;

    // ── 经济参数 ──────────────────────────────────────────────
    // 设计依据（实测开局 110 种着法的费用分布）：
    //   最便宜 0.0090 · 平均 0.1027 · 最贵 0.5775 MON
    //   一局最多 80 手（单人约 27 手）→ 全走便宜着法约 0.243 MON，
    //   但只要走一手贵的（车/炮长途）就要 0.1~0.58 MON。
    //
    // 旧值是质押 1 + 作战 2 = 入座 3 MON，三个座位就是 9 MON —— 对测试网
    // 玩家门槛太高，而且作战余额 2 MON 让"逼破产"永远不可能发生
    // （80 手全走最贵也才花 15.6，但没人会那样下）。现在按"约 3 手贵着法
    // 或 30 手便宜着法就破产"来定，让油费真正成为要经营的资源。
    uint256 public constant SEAT_STAKE = 0.05 ether;
    uint256 public constant PLAY_BALANCE_INITIAL = 0.3 ether;
    uint256 public constant MIN_PLAY_BALANCE_TO_START = 0.05 ether;
    uint256 public constant TIMEOUT_PENALTY = 0.03 ether;
    uint256 public constant ILLEGAL_REVEAL_PENALTY = 0.05 ether;
    uint256 public constant COMMIT_REVEAL_WINDOW = 60;
    /// @dev 大厅闲置多久后，已入座者可以不需要其他人同意就放弃该局。
    ///      设 1 小时：正常邀请等待足够长，又不至于让钱被锁死。
    uint256 public constant LOBBY_ABANDON_TIMEOUT = 1 hours;
    uint256 public constant MAX_PLIES = 80;
    uint256 public constant DEFEAT_STAKE_SHARE_BPS = 4000;
    uint256 public constant POINT_TO_MON_RATE = 0.001 ether;
    uint8 public constant NODE_COUNT = 154;
    /// Legacy names: BOARD_W == NODE_COUNT, BOARD_H == 1 (node board)
    uint8 public constant BOARD_W = 154;
    uint8 public constant BOARD_H = 1;

    enum Phase {
        Lobby,
        Playing,
        Finished,
        /// @dev 大厅被集体放弃：钱不会自动推送，各座用 claimAbandonRefund 自取。
        ///      放在末尾是为了不改变已有枚举值（前端与索引器都按数字判断阶段）。
        Abandoned
    }

    struct SeatInfo {
        address player;
        uint256 seatStake;
        uint256 playBalance;
        uint32 points;
        bool eliminated;
        bool isAi; // hidden until AiRevealed; never emitted on join
        /// @dev 大厅被放弃后，该座可以自取的金额（质押 + 作战余额）。
        ///      用"拉取"而不是"推送"：abandonGame 里对三个座依次转账
        ///      会引入重入面，也会让放弃交易被某个收款方 revert 卡住。
        uint256 abandonRefund;
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
        uint8[160] board; // index = nodeId
        PendingCommit[3] commits;
        address winner;
        uint8 winnerSeat;
        uint8 secondSeat; // 终局第二名（20% 接收方）；未定则 255
        /// @dev 大厅最后一次状态变化的时间。用来判断"这局已经晾了多久"，
        ///      久到超时后允许已入座者单方面放弃（否则一个不来的人能永远锁住别人的钱）。
        uint64 lobbyIdleSince;
        /// @dev 大厅放弃投票的位图（bit i = 座位 i 已投票）。
        uint8 abandonVotes;
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
    event SeatStakeRefunded(uint256 indexed gameId, uint8 seat, uint256 amount);
    event PayoutSent(uint256 indexed gameId, uint8 seat, uint256 prize, uint256 stakeRefund, uint256 playRefund);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event ReputationWriteFailed(uint256 indexed gameId, address indexed ai);
    event AbandonVoted(uint256 indexed gameId, uint8 seat, address player, uint8 votes, uint8 needed);
    event GameAbandoned(uint256 indexed gameId, uint8 seatedCount);
    event AbandonRefundClaimed(uint256 indexed gameId, uint8 seat, address player, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner");
        _;
    }

    constructor(address registry_) {
        require(registry_ != address(0), "registry zero");
        require(registry_.code.length > 0, "registry not contract");
        owner = msg.sender;
        registry = AgentRegistry(registry_);
    }

    function setCovenant(address c) external onlyOwner {
        require(c != address(0), "covenant zero");
        covenant = c;
    }

    /// @notice 更换声誉注册表。历史上这里是不可变的，一旦接线错误所有结算都会
    ///         卡死且无补救手段（因为 finalizeGame 在付款后才调用 registry）。
    function setRegistry(address r) external onlyOwner {
        require(r != address(0), "registry zero");
        require(r.code.length > 0, "registry not contract");
        registry = AgentRegistry(r);
    }

    function createGame(uint8 aiSeat) external returns (uint256 gameId) {
        require(aiSeat < 3, "ai seat");
        gameId = nextGameId++;
        Game storage g = games[gameId];
        g.phase = Phase.Lobby;
        g.aiSeat = aiSeat;
        g.winnerSeat = 255;
        g.secondSeat = 255;
        g.lobbyIdleSince = uint64(block.timestamp);
        _setupInitialBoard(g);
        emit GameCreated(gameId);
    }

    function join(uint256 gameId, uint8 seat) external payable {
        Game storage g = games[gameId];
        require(g.phase == Phase.Lobby, "lobby");
        require(seat < 3, "seat");
        require(g.seats[seat].player == address(0), "taken");
        // 同一个地址不能占多个座位。
        // 否则一个人可以自己坐满三席、自己跟自己下（刷战绩、刷 AgentRegistry 声誉、
        // 也能用两个座位互相"背刺"来套诚意金）。三人博弈的前提是三方独立。
        // 顺带修掉一个隐患：`_seatOf` 只返回第一个匹配座位，占多座时
        // abandonGame 会算错该退给谁。
        for (uint8 i = 0; i < 3; i++) {
            require(g.seats[i].player != msg.sender, "one seat per address");
        }
        require(msg.value >= SEAT_STAKE + PLAY_BALANCE_INITIAL, "value");
        g.seats[seat].player = msg.sender;
        g.seats[seat].seatStake = SEAT_STAKE;
        g.seats[seat].playBalance = PLAY_BALANCE_INITIAL;
        g.seats[seat].points = 0;
        g.seats[seat].isAi = (seat == g.aiSeat);
        g.lobbyIdleSince = uint64(block.timestamp); // 有人入座就算"还在活动"
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

    /// @notice 放弃一个卡住的大厅局，让已入座的人能把钱取回去。
    ///
    /// @dev 为什么需要它：大厅局没有取消机制时，"有人建了房但不再来"会让另外两人
    ///      的 1 MON 质押 + 2 MON 作战余额永久卡在合约里（`finalizeGame` 拒绝处理
    ///      未开打的局，`join` 又因为座位被占而 revert）。实测已经产生过这样一局。
    ///
    /// 两种放行条件，满足其一即可：
    ///   1. 所有**已入座**的玩家都投票放弃 —— 防止单方面卷走别人的局；
    ///   2. 大厅闲置超过 `LOBBY_ABANDON_TIMEOUT` —— 防止一个不来的玩家无限期锁住别人的钱。
    ///
    /// 只对 Lobby 生效：开打之后要走正常的终局结算（那里的资金划分有完整规则）。
    ///
    /// 钱用**拉取**而不是推送：一口气给三个座转账会引入重入面，而且只要有一个收款方
    /// revert，整笔放弃交易就永远做不成。改成各座自己调 `claimAbandonRefund` 取。
    function abandonGame(uint256 gameId) external {
        require(gameId > 0 && gameId < nextGameId, "unknown game");
        Game storage g = games[gameId];
        require(g.phase == Phase.Lobby, "lobby");
        require(!g.settled, "settled");

        (uint8 mySeat, bool seated) = _seatOf(g, msg.sender);
        require(seated, "not seated");

        // ⚠️ 顺序很重要：超时判断必须用**投票前**的 idleSince。
        //    之前把刷新写在判断之前，等于拿 now 和 now+1h 比，超时分支永远进不去。
        uint256 idleSinceBefore = g.lobbyIdleSince;
        g.abandonVotes |= uint8(1) << mySeat;
        g.lobbyIdleSince = uint64(block.timestamp);

        uint8 seatedCount;
        uint8 votingCount;
        for (uint8 i = 0; i < 3; i++) {
            if (g.seats[i].player == address(0)) continue;
            seatedCount++;
            if (g.abandonVotes & (uint8(1) << i) != 0) votingCount++;
        }

        bool timedOut = block.timestamp >= idleSinceBefore + LOBBY_ABANDON_TIMEOUT;
        emit AbandonVoted(gameId, mySeat, msg.sender, votingCount, seatedCount);
        if (votingCount < seatedCount && !timedOut) return;

        // 标记为已放弃并给每个座记下可自取的金额。
        // 复用 `settled` 是为了让 finalizeGame 的 "settled" 守卫一并覆盖这里。
        g.phase = Phase.Abandoned;
        g.settled = true;
        for (uint8 i = 0; i < 3; i++) {
            SeatInfo storage si = g.seats[i];
            if (si.player == address(0)) continue;
            // playBalance 在入座时已经含了超付部分，所以两项相加就是该座应退全额
            uint256 amount = si.seatStake + si.playBalance;
            if (amount == 0) continue;
            si.seatStake = 0;
            si.playBalance = 0;
            si.abandonRefund = amount;
        }
        emit GameAbandoned(gameId, seatedCount);
    }

    /// @notice 取回被放弃大厅局里的钱（拉取模式，见 abandonGame 注释）。
    function claimAbandonRefund(uint256 gameId) external returns (uint256 amount) {
        require(gameId > 0 && gameId < nextGameId, "unknown game");
        Game storage g = games[gameId];
        require(g.phase == Phase.Abandoned, "not abandoned");

        (uint8 mySeat, bool seated) = _seatOf(g, msg.sender);
        require(seated, "not seated");

        SeatInfo storage s = g.seats[mySeat];
        amount = s.abandonRefund;
        require(amount > 0, "nothing to claim");
        s.abandonRefund = 0;
        _pay(msg.sender, amount);
        emit AbandonRefundClaimed(gameId, mySeat, msg.sender, amount);
    }

    /// @notice 某个座是否已投票放弃、是否已可领取退款。
    function abandonStatusOf(uint256 gameId)
        external
        view
        returns (uint8 votes, bool canForceByTimeout, uint256 claimableForCaller)
    {
        Game storage g = games[gameId];
        votes = g.abandonVotes;
        canForceByTimeout = block.timestamp >= uint256(g.lobbyIdleSince) + LOBBY_ABANDON_TIMEOUT;
        for (uint8 i = 0; i < 3; i++) {
            if (g.seats[i].player == msg.sender) claimableForCaller = g.seats[i].abandonRefund;
        }
    }

    /// @dev 找出 msg.sender 坐的座位。同一地址可以坐多个座（历史行为，暂不改变），
    ///      这里返回第一个，使重复入座的语义保持可预期。
    function _seatOf(Game storage g, address who) internal view returns (uint8 seat, bool found) {
        for (uint8 i = 0; i < 3; i++) {
            if (g.seats[i].player == who) return (i, true);
        }
        return (0, false);
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

    /// @param x nodeId · @param y must be 0 (kept for ABI compatibility)
    function cell(uint256 gameId, uint8 x, uint8 y) external view returns (uint8 piece, uint8 seatOr255) {
        require(y == 0, "y");
        require(x < NODE_COUNT, "node");
        uint8 packed = games[gameId].board[x];
        if (packed == 0) return (0, 255);
        return (packed & 0x0f, (packed >> 4) - 1);
    }

    function previewMoveFee(uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1) external pure returns (uint256) {
        y0;
        y1;
        return SanrenRules.fee(piece, x0, x1);
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

    /// @notice 查询"当前行棋方是否留了一个可以清掉的过期 commit"。
    ///
    /// @dev 为什么需要它：`expireCommit` 是**无需许可**的（任何人都能关掉卡住的
    ///      commit，防止某人 commit 后跑路把整局锁死），但前端需要一个办法知道
    ///      "现在能不能点这个按钮"。`commits` 是 internal，没有公开 getter，
    ///      所以补这一个只读入口。返回 remaining = 还要等多少秒（0 表示现在就能清）。
    function pendingCommitOf(uint256 gameId)
        external
        view
        returns (bool pending, uint64 committedAt, uint256 remaining)
    {
        Game storage g = games[gameId];
        if (g.phase != Phase.Playing) return (false, 0, 0);
        PendingCommit storage pc = g.commits[g.turn];
        if (pc.commitHash == bytes32(0)) return (false, 0, 0);
        uint256 unlockAt = uint256(pc.commitTime) + COMMIT_REVEAL_WINDOW;
        remaining = block.timestamp >= unlockAt ? 0 : unlockAt - block.timestamp;
        return (true, pc.commitTime, remaining);
    }

    /// @notice 一次交易完成"提交 + 揭示"，用户只需签一次名。
    ///
    /// @dev 为什么可以这么做：`revealMove` 本来就要求 `g.turn == seat`，
    ///      也就是必须轮到你才能交。在这个前提下 commit-reveal 并没有隐藏
    ///      任何信息 —— 对手在你之后才走，看不到"抢跑"你的机会。所以把两步
    ///      压成一步不会损失任何安全性，只是把每步两次签名降到一次。
    ///
    ///      真要做成暗棋（三座同时提交、再一起揭示），需要把回合推进与
    ///      超时惩罚一起重写；那是独立的一次改动，见 PRD 的 P0 条目。
    ///
    ///      `commitHash` 仍然要求调用方传进来并做校验，保留原语义：
    ///      调用方必须证明自己知道 (走法, salt) 的承诺，而不是直接塞明文。
    function commitAndRevealMove(
        uint256 gameId,
        uint8 fromX,
        uint8 fromY,
        uint8 toX,
        uint8 toY,
        uint8 piece,
        bytes32 salt,
        bytes32 commitHash
    ) external {
        // ⚠️ 必须内联，不能用 this.commitMove()/this.revealMove()：外部调用会把
        //    msg.sender 变成合约自己，那里面的 `seats[seat].player == msg.sender`
        //    会立刻失败（实测 "turn"）。下面这几行就是从那两个入口抄来的前置校验。
        Game storage g = games[gameId];
        require(g.phase == Phase.Playing, "playing");
        uint8 seat = g.turn;
        require(g.seats[seat].player == msg.sender, "turn");
        require(!g.seats[seat].eliminated, "out");
        require(g.commits[seat].commitHash == bytes32(0), "pending");

        // 承诺必须与明文一致，否则等同伪造
        require(
            commitHash == keccak256(abi.encode(seat, fromX, fromY, toX, toY, piece, salt)),
            "commit mismatch"
        );

        g.commits[seat].commitHash = commitHash;
        g.commits[seat].commitTime = uint64(block.timestamp);
        g.commits[seat].illegalAttempts = 0;
        emit MoveCommitted(gameId, seat, commitHash);

        _revealMove(gameId, fromX, fromY, toX, toY, piece, salt);
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
        _revealMove(gameId, fromX, fromY, toX, toY, piece, salt);
    }

    function _revealMove(
        uint256 gameId,
        uint8 fromX,
        uint8 fromY,
        uint8 toX,
        uint8 toY,
        uint8 piece,
        bytes32 salt
    ) internal {
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

        require(fromY == 0 && toY == 0, "use node ids");
        require(_isLegal(g, seat, piece, fromX, fromY, toX, toY), "illegal geom");

        (uint8 dstPiece, uint8 dstSeat) = _unpack(g.board[toX]);

        uint256 fee = SanrenRules.fee(piece, fromX, toX);
        require(g.seats[seat].playBalance >= fee, "fee");
        g.seats[seat].playBalance -= fee;
        g.moveFeeTreasury += fee;
        g.feesPaid[seat] += fee;
        emit MoveFeePaid(gameId, seat, fee, g.seats[seat].playBalance);

        g.board[fromX] = 0;
        g.board[toX] = _pack(piece, seat);
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

    /// @dev Demo/director: 挪子（隔河图背刺演示：绿马放到可吃红士的攻位）。
    function directorRelocate(uint256 gameId, uint8 fromNode, uint8 toNode) external onlyOwner {
        Game storage g = games[gameId];
        require(fromNode < NODE_COUNT && toNode < NODE_COUNT, "node");
        require(g.board[fromNode] != 0, "empty");
        require(g.board[toNode] == 0, "occ");
        g.board[toNode] = g.board[fromNode];
        g.board[fromNode] = 0;
    }

    function finalizeGame(uint256 gameId, bytes32 motiveLogHash) external {
        require(gameId > 0 && gameId < nextGameId, "unknown game");
        Game storage g = games[gameId];
        require(!g.settled, "settled");
        // 只有真正开打过的局才能结算。
        // 老版本这里是 `g.phase == Finished || _aliveCount(g) <= 1 || ply >= MAX_PLIES`，
        // 而 _aliveCount 只数"已入座且未出局"的座 —— Lobby 里只坐了一个人时它等于 1，
        // 于是任何人都能把一局还没开始的游戏结算掉：赢家被设成 address(0)、后续 join
        // 全部 revert "lobby"、已入座者的 1 MON 质押永久卡死。已实测复现。
        require(
            g.phase == Phase.Finished
                || (g.phase == Phase.Playing && (_aliveCount(g) <= 1 || g.ply >= MAX_PLIES)),
            "not done"
        );
        if (g.phase != Phase.Finished) {
            if (_aliveCount(g) == 1) {
                for (uint8 i = 0; i < 3; i++) {
                    // 必须同时要求 player != address(0)，与 _aliveCount 的谓词保持一致，
                    // 否则空座会被加冕为胜者。
                    if (!g.seats[i].eliminated && g.seats[i].player != address(0)) {
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

        // settled 必须在任何外部调用（_payout 里的 _pay）之前置位，
        // 否则合约胜者可以重入 finalizeGame，让 AgentRegistry 把同一局记两次。
        g.settled = true;
        _payout(g, gameId);

        // 声誉写入放在最后，但此时 settled 已置位，重入无法再次到达这里。
        // 用 try/catch 包住：注册表拒绝写入（例如 AI 地址尚未注册）绝不能
        // 把整笔结算回滚 —— 那会让所有质押永久锁死。声誉写失败时只发事件。
        address ai = g.seats[g.aiSeat].player;
        if (ai != address(0)) {
            bool aiWon = (g.winnerSeat == g.aiSeat);
            uint256 forcedBurn = 0;
            for (uint8 i = 0; i < 3; i++) {
                if (i != g.aiSeat) forcedBurn += g.feesPaid[i];
            }
            try registry.recordGameResult(ai, gameId, aiWon, g.slashed[g.aiSeat], forcedBurn) {}
            catch {
                emit ReputationWriteFailed(gameId, ai);
            }
        }

        emit GameFinalized(gameId, g.winnerSeat);
    }

    /// @notice 只允许 AI 座位本人揭示自己的动机日志。
    /// @dev 老版本是 `require(phase == Finished || msg.sender == owner)`，任何人在结算前
    ///      都能抢先写入 motiveLogHash，而 UI 只能从事件读它 —— 等于首个调用者替 AI 写遗言。
    function revealAiOnly(uint256 gameId, bytes32 motiveLogHash) external {
        require(gameId > 0 && gameId < nextGameId, "unknown game");
        Game storage g = games[gameId];
        require(g.phase == Phase.Finished, "phase");
        require(!g.aiRevealed, "done");
        require(!g.settled, "settled");
        address ai = g.seats[g.aiSeat].player;
        require(ai != address(0) && msg.sender == ai, "only ai");
        g.aiRevealed = true;
        g.motiveLogHash = motiveLogHash;
        emit AiRevealed(gameId, g.aiSeat, motiveLogHash);
    }

    /// @notice 协议金库提现。此前没有任何提现路径，treasury 是死钱。
    /// @dev 记录按局存放（每局各记一份），所以这里只以合约实际余额为上限付款，
    ///      并同步扣减该局的记账值。即使各局账面之和与实际余额有差异
    ///      （例如有人直接转账进来），也不会出现付不出的情况。
    function withdrawTreasury(uint256 gameId, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to zero");
        require(gameId > 0 && gameId < nextGameId, "unknown game");
        uint256 bal = address(this).balance;
        uint256 take = amount > bal ? bal : amount;
        require(take > 0, "nothing");
        uint256 booked = games[gameId].protocolTreasury;
        games[gameId].protocolTreasury = booked >= take ? booked - take : 0;
        _pay(to, take);
        emit TreasuryWithdrawn(to, take);
    }

    function protocolTreasuryOf(uint256 gameId) external view returns (uint256) {
        return games[gameId].protocolTreasury;
    }

    function getMotiveLogHash(uint256 gameId) external view returns (bytes32) {
        return games[gameId].motiveLogHash;
    }

    function secondSeatOf(uint256 gameId) external view returns (uint8) {
        return games[gameId].secondSeat;
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

    /// @dev 任意合法着法的费用上界（精确值，不是估计）：
    ///      moveFee = (baseFee + steps × distUnit) × pieceMult
    ///      最长一条线 15 个点 → steps ≤ 14；pieceMult 最大是车的 2.0。
    ///      maxFee = (0.010 + 14 × 0.005) × 2.0 = 0.16 MON。
    uint256 internal constant MAX_POSSIBLE_MOVE_FEE = 0.16 ether;

    /// @dev 任意合法着法的费用下界：baseFee × 卒的系数 0.6 = 0.009 MON。
    ///      任何着法都是 (baseFee + …) × mult，而 mult 最小就是卒的 0.6。
    uint256 internal constant MIN_POSSIBLE_MOVE_FEE = 0.009 ether;

    function _checkBankruptcy(Game storage g, uint256 gameId, uint8 seat) internal {
        if (g.seats[seat].eliminated || g.phase != Phase.Playing) return;
        if (g.seats[seat].player == address(0)) return;

        uint256 bal = g.seats[seat].playBalance;

        // 三档判定。首尾两档都能给出**与全量扫描完全一致**的结论，
        // 只有夹在中间的窄带才需要真扫。
        //
        // 为什么必须这样：_minLegalFee 是全量枚举 ——
        // NODE_COUNT² × 棋子数 ≈ 139×139×16 ≈ 3×10^5 次 isLegal，实测约 3800 万 gas，
        // 超过 3000 万的区块上限。而 _checkBankruptcy 每次 revealMove 会被调用两次
        // （走子方 + 下一方），所以正常走一步都会 Out of gas。

        // (1) 余额高于"最贵着法"的上界 → 一定付得起最便宜的那一步。未破产。
        if (bal > MAX_POSSIBLE_MOVE_FEE) return;

        // (2) 余额低于"最便宜着法"的下界 → 连理论最低价都付不起。必定破产，无需扫描。
        if (bal < MIN_POSSIBLE_MOVE_FEE) {
            _bankrupt(g, gameId, seat);
            return;
        }

        // (3) 窄带（0.009 ~ 0.16 MON）：最便宜着法是否付得起取决于盘面，只能精确扫描。
        (bool any, uint256 minFee) = _minLegalFee(g, seat);
        if (!any || bal < minFee) {
            _bankrupt(g, gameId, seat);
        }
    }

    /// @dev 破产结算：点数转入孤儿池、质押进奖池、若有唯一幸存者则终局。
    function _bankrupt(Game storage g, uint256 gameId, uint8 seat) internal {
        g.seats[seat].eliminated = true;
        g.orphanPoints += g.seats[seat].points;
        g.seats[seat].points = 0;
        g.prizePool += g.seats[seat].seatStake;
        g.seats[seat].seatStake = 0;
        emit SeatBankrupt(gameId, seat, 255);
        if (_aliveCount(g) == 1) {
            for (uint8 i = 0; i < 3; i++) {
                if (!g.seats[i].eliminated && g.seats[i].player != address(0)) {
                    g.phase = Phase.Finished;
                    g.winnerSeat = i;
                    g.winner = g.seats[i].player;
                }
            }
        } else if (g.turn == seat) {
            _advanceTurn(g);
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

        // 记录本局开始时合约的余额与本局实际付出的金额，这样才能算出"本局留下的
        // 无人认领余额"。绝不能直接用 address(this).balance —— 那里面还包含其他
        // 尚未结算的对局的质押与作战余额，把它们记进本局金库会导致跨局串账。
        uint256 balBefore = address(this).balance;
        uint256 paid = 0;

        if (g.winnerSeat >= 3) {
            // 没有胜者（理论上不该发生）：把资金退回各座。
            paid += _refundAllSeats(g, gameId);
            uint256 leftover = balBefore > paid ? balBefore - paid : 0;
            if (leftover > 0) g.protocolTreasury += leftover;
            return;
        }

        uint256 toWinner = (pool * 7000) / 10000;
        uint256 toSecond = (pool * 2000) / 10000;
        // 协议那 10%（pool - toWinner - toSecond）【不】在这里单独记账：它本来就
        // 包含在"本局留下的残差"里（见函数末尾）。单独再加一次会让记账值超过
        // 合约实际余额（实测 4.4 vs 4.2），破坏"金库记账 == 合约余额"的不变式。

        // 第二名：按点数取【最后】一个最大值（与历史行为一致，不改经济结果），
        // 但显式跳过胜者与空座 —— 老版本的循环不跳过空座，理论上会把 20% 发给
        // 从未入座的 address(0)（实测该笔付款被 _pay 静默跳过，钱留在合约里）。
        uint8 second = 255;
        uint32 secondPts = 0;
        for (uint8 i = 0; i < 3; i++) {
            if (i == g.winnerSeat) continue;
            if (g.seats[i].player == address(0)) continue;
            if (g.seats[i].points >= secondPts) {
                secondPts = g.seats[i].points;
                second = i;
            }
        }
        g.secondSeat = second;

        // 胜者：70% + 自己的 stake 全额退回 + 剩余 playBalance 全退
        {
            SeatInfo storage w = g.seats[g.winnerSeat];
            uint256 stakeRefund = w.seatStake;
            uint256 playRefund = w.playBalance;
            w.seatStake = 0;
            w.playBalance = 0;
            uint256 total = toWinner + stakeRefund + playRefund;
            if (total > 0) {
                _pay(w.player, total);
                paid += total;
            }
            emit PayoutSent(gameId, g.winnerSeat, toWinner, stakeRefund, playRefund);
        }

        // 第二名：20% + 自己的 stake 全额退回 + 剩余 playBalance 全退
        if (second < 3) {
            SeatInfo storage s2 = g.seats[second];
            uint256 stakeRefund = s2.seatStake;
            uint256 playRefund = s2.playBalance;
            s2.seatStake = 0;
            s2.playBalance = 0;
            uint256 total = toSecond + stakeRefund + playRefund;
            if (total > 0) {
                _pay(s2.player, total);
                paid += total;
            }
            emit PayoutSent(gameId, second, toSecond, stakeRefund, playRefund);
        }

        // 其余仍然存活但既非胜者也非第二的座：不发奖金，但必须把自己的 seatStake
        // 与 playBalance 全额拿回去。老版本只退 playBalance，seatStake 留在账上而
        // 钱躺在合约里 —— 平均每局约 2 MON 永久卡死，因为合约没有任何提现函数。
        for (uint8 i = 0; i < 3; i++) {
            if (i == g.winnerSeat || i == second) continue;
            SeatInfo storage s = g.seats[i];
            if (s.player == address(0)) continue;
            uint256 stakeRefund = s.seatStake;
            uint256 playRefund = s.playBalance;
            s.seatStake = 0;
            s.playBalance = 0;
            if (stakeRefund > 0) emit SeatStakeRefunded(gameId, i, stakeRefund);
            uint256 total = stakeRefund + playRefund;
            if (total > 0) {
                _pay(s.player, total);
                paid += total;
            }
            emit PayoutSent(gameId, i, 0, stakeRefund, playRefund);
        }

        // 本局留下的、无人认领的余额（例如 directorDrain 清掉账面数字后仍留在
        // 合约里的那部分）归入本局金库，由 owner 通过 withdrawTreasury 提取，
        // 不再无主。注意这里只算【本局】的残差，不碰其他对局的资金。
        uint256 residual = balBefore > paid ? balBefore - paid : 0;
        if (residual > 0) g.protocolTreasury += residual;
    }

    /// @dev 无胜者时的退回路径：把每个座位的 stake 与 playBalance 原样退还。
    /// @return paid 实际付出的总额。
    function _refundAllSeats(Game storage g, uint256 gameId) internal returns (uint256 paid) {
        for (uint8 i = 0; i < 3; i++) {
            SeatInfo storage s = g.seats[i];
            if (s.player == address(0)) continue;
            uint256 stakeRefund = s.seatStake;
            uint256 playRefund = s.playBalance;
            s.seatStake = 0;
            s.playBalance = 0;
            if (stakeRefund > 0) emit SeatStakeRefunded(gameId, i, stakeRefund);
            uint256 total = stakeRefund + playRefund;
            if (total > 0) {
                _pay(s.player, total);
                paid += total;
            }
            emit PayoutSent(gameId, i, 0, stakeRefund, playRefund);
        }
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
        if (y0 != 0 || y1 != 0) return false;
        return SanrenRules.isLegal(g.board, seat, piece, x0, x1);
    }

    function _minLegalFee(Game storage g, uint8 seat) internal view returns (bool any, uint256 minFee) {
        minFee = type(uint256).max;
        for (uint8 from = 0; from < NODE_COUNT; from++) {
            (uint8 piece, uint8 s) = _unpack(g.board[from]);
            if (piece == 0 || s != seat) continue;
            for (uint8 to = 0; to < NODE_COUNT; to++) {
                if (!_isLegal(g, seat, piece, from, 0, to, 0)) continue;
                uint256 fee = SanrenRules.fee(piece, from, to);
                if (!any || fee < minFee) {
                    any = true;
                    minFee = fee;
                }
            }
        }
    }

    function _setupInitialBoard(Game storage g) internal {
        uint16 n = SanrenData.setupCount();
        for (uint16 i = 0; i < n; i++) {
            (uint8 node, uint8 piece, uint8 seat) = SanrenData.setupAt(i);
            g.board[node] = _pack(piece, seat);
        }
    }

    receive() external payable {}
}
