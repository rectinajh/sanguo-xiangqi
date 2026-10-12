// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "./interfaces/IVerifier.sol";
import {IGameTable} from "./interfaces/IGameTable.sol";

/// @notice 诚意金 + 双签盟约激活 + 凭链上吃子证据 Slash（G1 隐私档）
///
/// 本次修订修掉了评审里确认的五个问题：
///   H3  activateCovenant 让调用方替对方出 bond → 改为按调用者身份收款
///   H6  0.05 诚意金溢价收了不记账不退 → 记入 premium 并参与退款/抵扣
///   B2  背刺者可以自己 fulfillCovenant 跑掉 → 加违规检查 + 终局守卫
///   B3  activeBySeat / pendingCountBySeat 是 public，G1 隐私形同虚设 → 改 internal
///   H7b 签名不绑定条款与金额 → 完整 preimage 参与签名，条款由签名者自己指定
contract Covenant {
    uint256 public constant EARNEST_BOND = 0.1 ether;
    uint256 public constant BOND_PER_CLAUSE = 0.15 ether;
    uint256 public constant EARNEST_TIMEOUT_SECS = 90;
    uint8 public constant EARNEST_TIMEOUT_PLIES = 3;
    uint8 public constant CLAUSE_NO_CAPTURE_ADVISOR = 1;
    uint8 public constant CLAUSE_NO_EXPOSE_BEFORE_END = 2;
    uint8 public constant CLAUSE_BUY_PEACE = 4;
    uint256 public constant EXTRA_EARNEST_PREMIUM = 0.05 ether;
    uint8 public constant BASE_PENDING_EARNEST = 1;
    uint8 public constant WHALE_PENDING_EARNEST = 3;
    /// @dev "巨鲸"门槛 = 3 倍开局作战余额。
    ///      ⚠️ 这个值与 GameTable.PLAY_BALANCE_INITIAL（0.3 ether）**耦合**，
    ///      同步改。曾写死成 3 ether —— 降参后没有任何玩家能达到，鲸鱼档
    ///      （可挂 3 个待定诚意金）变成了死代码，测试才把它暴露出来。
    uint256 public constant WHALE_PLAY_BALANCE_THRESHOLD = 3 * 0.3 ether;
    uint8 public constant BUY_PEACE_DEFAULT_PLIES = 8;
    uint8 public constant MAX_CLAUSES = 8;

    enum Status {
        None,
        PendingEarnest,
        Active,
        Slashed,
        Fulfilled,
        Expired
    }

    /// @notice 盟约完整条款。covenantHash = keccak256(abi.encode(CovenantPreimage))。
    /// @dev 老版本的 hash 由前端随手拼一个 string/uint 得到，链上 [activateCovenant]
    ///      收的 clauses 来自 calldata 且从不与 hash 校验 —— 于是"签名过的条款"和
    ///      "真正生效的条款"可以是两回事，调用者能现选条款与 bond 金额。
    ///      现在签名直接覆盖整个 preimage，条款由签名者本人指定。
    struct CovenantPreimage {
        uint256 gameId;
        uint8 seatI;
        uint8 seatJ;
        uint8[] clauses;
        uint256 bondAmount;
        uint256 earnestBond;
        bytes32 nonce;
        uint32 validFromPly;
        uint32 validToPly;
    }

    struct CovenantData {
        Status status;
        bytes32 hash;
        address proposer;
        address counterparty;
        address playerI;
        address playerJ;
        uint8 seatI;
        uint8 seatJ;
        uint8[] clauses;
        uint256 earnestAmount;
        uint256 premium; // H6：第 2+ 笔诚意金多收的 0.05，必须记账才能退
        uint256 bondTotal;
        uint256 bondI;
        uint256 bondJ;
        uint64 lockedAt;
        uint32 lockedPly;
        uint32 activatedPly;
        uint64 activatedAt; // 激活时的墙钟时间，用于履约冷静期
        uint256 gameId;
        bool seatsRevealed;
    }

    IVerifier public verifier;
    address public owner;
    address public gameTable;

    mapping(bytes32 => CovenantData) internal covenants;
    // B3：这两个映射原本是 public。任何人都能直接读出"哪两个座结了盟"以及
    // "哪个座正在求援"，G1 承诺的"激活时隐藏当事人"在链上完全不成立。
    // 改成 internal，当事人通过 partiesOf() 自行核对。
    mapping(uint256 => mapping(uint8 => bytes32)) internal activeBySeat;
    mapping(uint256 => mapping(uint8 => uint8)) internal pendingCountBySeat;
    mapping(bytes32 => uint8) public peacePlies;
    mapping(bytes32 => uint256) public bribeEscrow;
    mapping(bytes32 => uint8) internal proposerSeat;

    event EarnestLocked(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 amount);
    event EarnestRefunded(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 amount);
    event CovenantActivated(uint256 indexed gameId, bytes32 indexed covenantHash);
    event BetrayalSlashed(
        uint256 indexed gameId, bytes32 indexed covenantHash, uint256 amount, uint8 betrayerSeat, uint8 victimSeat
    );
    event CovenantFulfilled(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 amount);
    event PeaceBribeLocked(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 bribe, uint8 plies);
    event ExtraEarnestPremiumPaid(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 premium);

    constructor(address verifier_) {
        require(verifier_ != address(0), "verifier zero");
        owner = msg.sender;
        verifier = IVerifier(verifier_);
    }

    function setGameTable(address g) external {
        require(msg.sender == owner, "owner");
        require(g != address(0), "zero");
        gameTable = g;
    }

    // —— 锁诚意金 —— //

    /// @notice 锁诚意金。上限取决于该座链上的 playBalance。事件不含座位。
    function lockEarnest(uint256 gameId, bytes32 covenantHash, uint8 seat) external payable {
        _lock(gameId, covenantHash, seat, 0, 0);
    }

    /// @notice 氪金「疏火」：诚意金 + 贿金一起锁。当事人不进事件。
    function lockPeaceOffer(uint256 gameId, bytes32 covenantHash, uint8 seat, uint256 bribeAmount, uint8 plies)
        external
        payable
    {
        require(bribeAmount > 0, "bribe");
        require(plies > 0 && plies <= 20, "plies");
        _lock(gameId, covenantHash, seat, bribeAmount, plies);
        emit PeaceBribeLocked(gameId, covenantHash, bribeAmount, plies);
    }

    function _lock(uint256 gameId, bytes32 covenantHash, uint8 seat, uint256 bribeAmount, uint8 plies) internal {
        require(seat < 3, "seat");
        require(covenants[covenantHash].status == Status.None, "exists");
        (address player,, uint256 playBal,,) = IGameTable(gameTable).getSeat(gameId, seat);
        require(player == msg.sender, "seat");
        (uint8 phase,, uint32 ply,,,) = IGameTable(gameTable).getGameMeta(gameId);
        // 只在真正开局后允许锁诚意金，否则"3 手停火窗口"这类基于 ply 的条款没有意义
        require(phase == 1, "not playing");

        uint8 cap = playBal >= WHALE_PLAY_BALANCE_THRESHOLD ? WHALE_PENDING_EARNEST : BASE_PENDING_EARNEST;
        uint8 cur = pendingCountBySeat[gameId][seat];
        require(cur < cap, "pending cap");
        uint256 premium = cur >= BASE_PENDING_EARNEST ? EXTRA_EARNEST_PREMIUM : 0;
        uint256 required = EARNEST_BOND + premium + bribeAmount;
        require(msg.value >= required, "value");

        CovenantData storage c = covenants[covenantHash];
        c.status = Status.PendingEarnest;
        c.hash = covenantHash;
        c.proposer = msg.sender;
        c.earnestAmount = EARNEST_BOND;
        c.premium = premium; // H6：要记账，否则退款时这 0.05 永远留在合约里
        if (bribeAmount > 0) {
            bribeEscrow[covenantHash] = bribeAmount;
            peacePlies[covenantHash] = plies;
        }
        c.lockedAt = uint64(block.timestamp);
        c.lockedPly = ply;
        c.gameId = gameId;
        c.seatI = seat;
        pendingCountBySeat[gameId][seat] = cur + 1;
        proposerSeat[covenantHash] = seat;
        if (premium > 0) emit ExtraEarnestPremiumPaid(gameId, covenantHash, premium);

        // 多付的钱当场退回，不要留在合约里当无主资金
        uint256 surplus = msg.value - required;
        if (surplus > 0) _pay(msg.sender, surplus);

        emit EarnestLocked(gameId, covenantHash, EARNEST_BOND);
    }

    function refundExpiredEarnest(bytes32 covenantHash) external {
        CovenantData storage c = covenants[covenantHash];
        require(c.status == Status.PendingEarnest, "status");
        (,, uint32 currentPly,,,) = IGameTable(gameTable).getGameMeta(c.gameId);
        bool timedOut = block.timestamp >= c.lockedAt + EARNEST_TIMEOUT_SECS
            || currentPly >= c.lockedPly + EARNEST_TIMEOUT_PLIES;
        require(timedOut || msg.sender == c.proposer, "wait");
        c.status = Status.Expired;
        // H6：premium 也一并退回
        uint256 amt = c.earnestAmount + c.premium + bribeEscrow[covenantHash];
        c.earnestAmount = 0;
        c.premium = 0;
        bribeEscrow[covenantHash] = 0;
        uint8 ps = proposerSeat[covenantHash];
        if (pendingCountBySeat[c.gameId][ps] > 0) pendingCountBySeat[c.gameId][ps] -= 1;
        _pay(c.proposer, amt);
        emit EarnestRefunded(c.gameId, covenantHash, amt);
    }

    // —— 激活 —— //

    /// @dev 双签覆盖完整 preimage（EIP-191 personal_sign 包住 keccak256(abi.encode(p))）。
    ///      seatI / seatJ / clauses / bondAmount 都来自 preimage，签名者签的就是这些值。
    ///      空 zkProof 走 P0 的 ECDSA 路径；非空证明必须通过验证器。
    function activateCovenant(
        CovenantPreimage calldata p,
        bytes calldata sigI,
        bytes calldata sigJ,
        bytes calldata zkProof
    ) external payable {
        require(p.seatI < 3 && p.seatJ < 3 && p.seatI != p.seatJ, "seats");
        require(p.clauses.length >= 2 && p.clauses.length <= MAX_CLAUSES, "clauses");
        require(p.earnestBond == EARNEST_BOND, "earnest");

        bytes32 h = hashPreimage(p);
        CovenantData storage c = covenants[h];
        require(c.status == Status.PendingEarnest, "pending");
        require(c.gameId == p.gameId, "game");
        require(activeBySeat[p.gameId][p.seatI] == bytes32(0), "busy i");
        require(activeBySeat[p.gameId][p.seatJ] == bytes32(0), "busy j");

        address signerI = _recover(h, sigI);
        address signerJ = _recover(h, sigJ);
        require(signerI != address(0) && signerJ != address(0), "sig");
        require(signerI != signerJ, "same");
        require(c.proposer == signerI || c.proposer == signerJ, "proposer");

        (address pI,,,,) = IGameTable(gameTable).getSeat(p.gameId, p.seatI);
        (address pJ,,,,) = IGameTable(gameTable).getSeat(p.gameId, p.seatJ);
        require((signerI == pI && signerJ == pJ) || (signerI == pJ && signerJ == pI), "parties");

        // 调用者必须是当事人之一：老版本允许任何第三方来出资激活，
        // 并把 proposer 的缺口算到调用者头上（H3）。
        address caller = msg.sender;
        require(caller == pI || caller == pJ, "caller not party");

        require(verifier.verifyCovenantProof(h, zkProof), "zk");

        // H7b：bond 金额来自被签名的 preimage，不再由调用者临时按条款数推算
        require(p.bondAmount == uint256(p.clauses.length) * BOND_PER_CLAUSE, "bond amount");

        uint256 bondTotal = p.bondAmount;
        uint256 each = bondTotal / 2;
        // 谁调用激活不重要，重要的是把两个角色分别记清楚：
        //   proposer     = 锁诚意金的那一方（_lock 里记录的 msg.sender）
        //   counterparty = 两名当事人里【不是发起方】的那一方
        // 这里按 proposer 推导，而不是按 caller 推导 —— 按 caller 推导会在
        // "由非发起方激活"时把两边角色写反，结果真正的当事人自己都过不了
        // fulfillCovenant 的 party 检查（本项目确实踩过这个坑）。
        address proposer = c.proposer;
        address counterparty;
        if (proposer == pI) {
            counterparty = pJ;
        } else {
            require(proposer == pJ, "proposer not party");
            counterparty = pI;
        }
        require(counterparty != proposer && counterparty != address(0), "counterparty");

        // bond 必须凑齐，否则 Slash 时会付不出钱（本项目确实踩过：发起方锁了
        // 0.1 诚意金、对手方只付了自己那半 0.15，合约里只有 0.25 却要转 0.3）。
        // 规则：调用者付清"还缺的部分"。
        //   - 发起方调用：补自己那一半的缺口
        //   - 对方调用  ：付自己那一半，同时替发起方补齐缺口
        // 后者的代价是对方暂时多垫 0.05，但 Slash/Fulfill 时按 bondPool 均分，
        // 多垫的部分会拿回来（Slash 场景下对方本来就是受害方）。
        uint256 proposerCredit = c.earnestAmount + c.premium;
        uint256 proposerOwed = each > proposerCredit ? each - proposerCredit : 0;
        uint256 callerOwed = caller == proposer ? proposerOwed : each;
        uint256 outstanding = proposerOwed + each;
        uint256 owed = caller == proposer ? callerOwed : outstanding;
        require(msg.value >= owed, "bond value");

        (,, uint32 ply,,,) = IGameTable(gameTable).getGameMeta(p.gameId);

        c.status = Status.Active;
        c.seatI = p.seatI;
        c.seatJ = p.seatJ;
        c.playerI = pI;
        c.playerJ = pJ;
        c.counterparty = counterparty;
        c.activatedPly = ply;
        c.activatedAt = uint64(block.timestamp);
        delete c.clauses;
        for (uint256 i = 0; i < p.clauses.length; i++) {
            c.clauses.push(p.clauses[i]);
        }
        c.bondTotal = bondTotal;
        c.bondI = each;
        c.bondJ = each;
        c.earnestAmount = 0;
        c.premium = 0;
        activeBySeat[p.gameId][p.seatI] = h;
        activeBySeat[p.gameId][p.seatJ] = h;

        uint256 needed = owed;
        if (msg.value > needed) _pay(caller, msg.value - needed);

        uint8 ps = proposerSeat[h];
        if (pendingCountBySeat[p.gameId][ps] > 0) pendingCountBySeat[p.gameId][ps] -= 1;

        bool hasPeace = false;
        for (uint256 i = 0; i < p.clauses.length; i++) {
            if (p.clauses[i] == CLAUSE_BUY_PEACE) hasPeace = true;
        }
        if (hasPeace && bribeEscrow[h] > 0) {
            uint256 bribe = bribeEscrow[h];
            bribeEscrow[h] = 0;
            _pay(counterparty, bribe);
            if (peacePlies[h] == 0) peacePlies[h] = BUY_PEACE_DEFAULT_PLIES;
        } else if (!hasPeace && bribeEscrow[h] > 0) {
            uint256 bribe = bribeEscrow[h];
            bribeEscrow[h] = 0;
            _pay(proposer, bribe);
        }

        emit CovenantActivated(p.gameId, h);
    }

    /// @notice 盟约哈希 = keccak256(abi.encode(preimage))。链下（前端/harness）必须用同一套编码。
    function hashPreimage(CovenantPreimage calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    /// @notice 当事人自查：我是否在这个 gameId 下有生效盟约，hash 是多少。
    /// @dev 故意只对两个当事人返回结果，第三方拿到的是空值 —— 这就是 G1 的链上边界。
    function partiesOf(uint256 gameId, uint8 seat) external view returns (bytes32 covenantHash) {
        bytes32 h = activeBySeat[gameId][seat];
        if (h == bytes32(0)) return bytes32(0);
        CovenantData storage c = covenants[h];
        if (msg.sender != c.playerI && msg.sender != c.playerJ) return bytes32(0);
        return h;
    }

    /// @notice 该座是否还有生效盟约（不透露对象是谁）。
    function hasActive(uint256 gameId, uint8 seat) external view returns (bool) {
        return activeBySeat[gameId][seat] != bytes32(0);
    }

    /// @notice 该座当前挂着几笔未决诚意金。只暴露数量，不暴露对象。
    function pendingCount(uint256 gameId, uint8 seat) external view returns (uint8) {
        return pendingCountBySeat[gameId][seat];
    }

    function getPeacePlies(bytes32 hash) external view returns (uint8) {
        return peacePlies[hash];
    }

    function activatedPlyOf(bytes32 hash) external view returns (uint32) {
        return covenants[hash].activatedPly;
    }

    /// @notice 当事人地址。仅在 seatsRevealed（Slashed/Fulfilled）后才对外可见，
    ///         否则只有当事人本人能读到自己的那一侧，第三方拿到的是全零。
    function partiesOfHash(bytes32 hash)
        external
        view
        returns (address proposer, address counterparty)
    {
        CovenantData storage c = covenants[hash];
        if (!c.seatsRevealed && msg.sender != c.playerI && msg.sender != c.playerJ) {
            return (address(0), address(0));
        }
        return (c.proposer, c.counterparty);
    }

    function clausesOf(bytes32 hash) external view returns (uint8[] memory) {
        return covenants[hash].clauses;
    }

    // —— 违约判定 —— //

    /// @dev 该盟约是否已经存在可被 Slash 的违规。fulfillCovenant 会先查这个。
    function _hasViolation(bytes32 h) internal view returns (bool has, uint8 betrayerSeat, uint8 clause) {
        CovenantData storage c = covenants[h];
        for (uint256 i = 0; i < c.clauses.length; i++) {
            uint8 cl = c.clauses[i];
            if (cl == CLAUSE_NO_CAPTURE_ADVISOR) {
                if (IGameTable(gameTable).advisorBetrayal(c.gameId, c.seatI, c.seatJ, c.activatedPly)) {
                    return (true, c.seatI, cl);
                }
                if (IGameTable(gameTable).advisorBetrayal(c.gameId, c.seatJ, c.seatI, c.activatedPly)) {
                    return (true, c.seatJ, cl);
                }
            } else if (cl == CLAUSE_BUY_PEACE) {
                uint32 untilPly = c.activatedPly + peacePlies[h];
                if (IGameTable(gameTable).peaceBetrayal(c.gameId, c.seatI, c.seatJ, c.activatedPly, untilPly)) {
                    return (true, c.seatI, cl);
                }
                if (IGameTable(gameTable).peaceBetrayal(c.gameId, c.seatJ, c.seatI, c.activatedPly, untilPly)) {
                    return (true, c.seatJ, cl);
                }
            }
        }
        return (false, 255, 0);
    }

    /// @notice 挑战背刺。调用者必须是受害方，证据是链上真实存在的吃子记录。
    function challengeBetrayal(bytes32 covenantHash, uint8 betrayerSeat, uint8 violatedClause) external {
        CovenantData storage c = covenants[covenantHash];
        require(c.status == Status.Active, "active");
        require(betrayerSeat == c.seatI || betrayerSeat == c.seatJ, "party");
        bool knownClause = false;
        for (uint256 i = 0; i < c.clauses.length; i++) {
            if (c.clauses[i] == violatedClause) knownClause = true;
        }
        require(knownClause, "clause");
        require(violatedClause != CLAUSE_NO_EXPOSE_BEFORE_END, "expose deferred");

        uint8 victim = betrayerSeat == c.seatI ? c.seatJ : c.seatI;
        address victimAddr = victim == c.seatI ? c.playerI : c.playerJ;
        require(msg.sender == victimAddr, "victim");

        if (violatedClause == CLAUSE_NO_CAPTURE_ADVISOR) {
            require(
                IGameTable(gameTable).advisorBetrayal(c.gameId, betrayerSeat, victim, c.activatedPly), "no capture"
            );
        } else if (violatedClause == CLAUSE_BUY_PEACE) {
            uint32 untilPly = c.activatedPly + peacePlies[covenantHash];
            require(
                IGameTable(gameTable).peaceBetrayal(c.gameId, betrayerSeat, victim, c.activatedPly, untilPly),
                "no capture"
            );
        } else {
            revert("type");
        }

        uint256 slashAmt = c.bondTotal;
        c.status = Status.Slashed;
        c.seatsRevealed = true;
        c.bondTotal = 0;
        c.bondI = 0;
        c.bondJ = 0;
        activeBySeat[c.gameId][c.seatI] = bytes32(0);
        activeBySeat[c.gameId][c.seatJ] = bytes32(0);

        if (slashAmt > 0) IGameTable(gameTable).creditSlash{value: slashAmt}(c.gameId, victim, betrayerSeat);
        emit BetrayalSlashed(c.gameId, covenantHash, slashAmt, betrayerSeat, victim);
    }

    /// @notice 履约平仓。
    /// @dev B2：老版本没有任何违规/阶段检查，背刺者只要抢在受害方 challenge 之前
    ///      调用本函数，就能把盟约变成 Fulfilled 并拿回自己的 bond，罚没完全落空。
    ///      现在：存在可 Slash 的违规 → 拒绝履约；游戏未终局 → 必须过冷静期。
    function fulfillCovenant(bytes32 covenantHash) external {
        CovenantData storage c = covenants[covenantHash];
        require(c.status == Status.Active, "active");
        require(msg.sender == c.proposer || msg.sender == c.counterparty, "party");

        (bool violated,,) = _hasViolation(covenantHash);
        require(!violated, "violation pending");

        (uint8 phase,,,,,) = IGameTable(gameTable).getGameMeta(c.gameId);
        if (phase != 2) {
            // 未终局：给受害方留出发现吃子并挑战的窗口，期间谁都不能单方面平仓。
            // 老版本没有任何窗口，背刺者抢跑一次 fulfill 就能让罚没彻底落空。
            require(block.timestamp >= c.activatedAt + FULFILL_COOLDOWN, "cooldown");
        }

        uint256 amount = c.bondTotal;
        uint256 half = amount / 2;
        address a = c.proposer;
        address b = c.counterparty;
        c.status = Status.Fulfilled;
        c.bondTotal = 0;
        c.bondI = 0;
        c.bondJ = 0;
        activeBySeat[c.gameId][c.seatI] = bytes32(0);
        activeBySeat[c.gameId][c.seatJ] = bytes32(0);
        _pay(a, half);
        _pay(b, amount - half); // 奇数时把零头给对手方，避免 1 wei 留在合约里
        emit CovenantFulfilled(c.gameId, covenantHash, amount);
    }

    /// @dev 未终局时履约的冷静期（秒）。必须显著长于受害方发现吃子并发起挑战的时间。
    uint256 public constant FULFILL_COOLDOWN = 5 minutes;

    // —— 查询 —— //

    function getCovenant(bytes32 hash)
        external
        view
        returns (Status status, uint256 gameId, uint256 bondTotal, bool seatsRevealed, uint8 seatI, uint8 seatJ)
    {
        CovenantData storage c = covenants[hash];
        status = c.status;
        gameId = c.gameId;
        bondTotal = c.bondTotal;
        seatsRevealed = c.seatsRevealed || c.status == Status.Slashed || c.status == Status.Fulfilled;
        if (seatsRevealed) {
            seatI = c.seatI;
            seatJ = c.seatJ;
        } else {
            seatI = 255;
            seatJ = 255;
        }
    }

    function _recover(bytes32 covenantHash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "siglen");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", covenantHash));
        return ecrecover(digest, v, r, s);
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0 || to == address(0)) return;
        (bool ok,) = to.call{value: amount}("");
        require(ok, "pay");
    }

    receive() external payable {}
}
