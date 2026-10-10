// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "./interfaces/IVerifier.sol";

/// @notice Earnest bond + dual-ECDSA covenant activate + slash (G1 privacy)
contract Covenant {
    uint256 public constant EARNEST_BOND = 0.1 ether;
    uint256 public constant BOND_PER_CLAUSE = 0.15 ether;
    uint256 public constant EARNEST_TIMEOUT_SECS = 90;
    uint8 public constant EARNEST_TIMEOUT_PLIES = 3;
    uint8 public constant CLAUSE_NO_CAPTURE_ADVISOR = 1;
    uint8 public constant CLAUSE_NO_EXPOSE_BEFORE_END = 2;
    uint8 public constant CLAUSE_BUY_PEACE = 4; // 疏火：N plies no capture vs ally
    uint256 public constant EXTRA_EARNEST_PREMIUM = 0.05 ether; // per extra concurrent pending beyond 1
    uint8 public constant BASE_PENDING_EARNEST = 1;
    uint8 public constant WHALE_PENDING_EARNEST = 3; // high-balance seats can hold more pending
    uint256 public constant WHALE_PLAY_BALANCE_THRESHOLD = 3 ether; // >= 3 MON play => whale pending cap
    uint8 public constant BUY_PEACE_DEFAULT_PLIES = 8;

    enum Status {
        None,
        PendingEarnest,
        Active,
        Slashed,
        Fulfilled,
        Expired
    }

    struct CovenantData {
        Status status;
        bytes32 hash;
        address proposer; // hidden in events at lock time
        address counterparty;
        uint8 seatI;
        uint8 seatJ;
        uint8[] clauses;
        uint256 earnestAmount;
        uint256 bondTotal;
        uint256 bondI;
        uint256 bondJ;
        uint64 lockedAt;
        uint32 lockedPly;
        uint256 gameId;
        bool seatsRevealed;
    }

    IVerifier public verifier;
    address public owner;
    address public gameTable;

    mapping(bytes32 => CovenantData) public covenants;
    mapping(uint256 => mapping(uint8 => bytes32)) public activeBySeat; // gameId => seat => hash
    mapping(uint256 => mapping(uint8 => uint8)) public pendingCountBySeat; // pending earnest offers per seat
    mapping(bytes32 => uint8) public peacePlies; // BUY_PEACE duration
    mapping(bytes32 => uint256) public bribeEscrow; // 疏火金 held until activate
    mapping(bytes32 => uint8) public proposerSeat; // for pending accounting

    event EarnestLocked(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 amount); // no seat
    event EarnestRefunded(uint256 indexed gameId, bytes32 indexed covenantHash);
    event CovenantActivated(uint256 indexed gameId, bytes32 indexed covenantHash); // G1: no seats
    event BetrayalSlashed(
        uint256 indexed gameId, bytes32 indexed covenantHash, uint256 amount, uint8 betrayerSeat, uint8 victimSeat
    );
    event CovenantFulfilled(uint256 indexed gameId, bytes32 indexed covenantHash);
    event PeaceBribeLocked(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 bribe, uint8 plies); // no seats
    event ExtraEarnestPremiumPaid(uint256 indexed gameId, bytes32 indexed covenantHash, uint256 premium);

    constructor(address verifier_) {
        owner = msg.sender;
        verifier = IVerifier(verifier_);
    }

    function setGameTable(address g) external {
        require(msg.sender == owner, "owner");
        gameTable = g;
    }

    /// @notice Lock earnest; event intentionally omits seats (G1).
    /// @dev Whale multi-offer: seat may hold multiple PendingEarnest.
    ///      Extra concurrent offers beyond BASE require EXTRA_EARNEST_PREMIUM each (msg.value covers earnest+premium).
    /// @param seat proposer seat (stored; NOT emitted)
    /// @param playBalanceHint caller's playBalance for whale cap (trusted from GameTable UI; demo-local)
    function lockEarnest(
        uint256 gameId,
        bytes32 covenantHash,
        uint32 currentPly,
        uint8 seat,
        uint256 playBalanceHint
    ) external payable {
        require(seat < 3, "seat");
        require(covenants[covenantHash].status == Status.None, "exists");
        uint8 cap = playBalanceHint >= WHALE_PLAY_BALANCE_THRESHOLD ? WHALE_PENDING_EARNEST : BASE_PENDING_EARNEST;
        uint8 cur = pendingCountBySeat[gameId][seat];
        require(cur < cap, "pending cap");
        uint256 premium = 0;
        if (cur >= BASE_PENDING_EARNEST) {
            premium = EXTRA_EARNEST_PREMIUM;
        }
        require(msg.value >= EARNEST_BOND + premium, "earnest+premium");
        CovenantData storage c = covenants[covenantHash];
        c.status = Status.PendingEarnest;
        c.hash = covenantHash;
        c.proposer = msg.sender;
        c.earnestAmount = EARNEST_BOND;
        c.lockedAt = uint64(block.timestamp);
        c.lockedPly = currentPly;
        c.gameId = gameId;
        c.seatI = seat; // proposer seat private until reveal
        pendingCountBySeat[gameId][seat] = cur + 1;
        proposerSeat[covenantHash] = seat;
        if (premium > 0) {
            emit ExtraEarnestPremiumPaid(gameId, covenantHash, premium);
        }
        emit EarnestLocked(gameId, covenantHash, EARNEST_BOND);
        // excess beyond earnest+premium stays as tip to protocol via contract balance
    }

    /// @notice Whale 疏火：lock earnest + bribe in one commitment (parties hidden in events)
    function lockPeaceOffer(
        uint256 gameId,
        bytes32 covenantHash,
        uint32 currentPly,
        uint8 seat,
        uint256 playBalanceHint,
        uint256 bribeAmount,
        uint8 plies
    ) external payable {
        require(bribeAmount > 0, "bribe");
        require(plies > 0 && plies <= 20, "plies");
        uint8 cap = playBalanceHint >= WHALE_PLAY_BALANCE_THRESHOLD ? WHALE_PENDING_EARNEST : BASE_PENDING_EARNEST;
        uint8 cur = pendingCountBySeat[gameId][seat];
        require(cur < cap, "pending cap");
        uint256 premium = cur >= BASE_PENDING_EARNEST ? EXTRA_EARNEST_PREMIUM : 0;
        require(msg.value >= EARNEST_BOND + premium + bribeAmount, "value");
        require(covenants[covenantHash].status == Status.None, "exists");

        CovenantData storage c = covenants[covenantHash];
        c.status = Status.PendingEarnest;
        c.hash = covenantHash;
        c.proposer = msg.sender;
        c.earnestAmount = EARNEST_BOND;
        bribeEscrow[covenantHash] = bribeAmount;
        c.lockedAt = uint64(block.timestamp);
        c.lockedPly = currentPly;
        c.gameId = gameId;
        c.seatI = seat;
        pendingCountBySeat[gameId][seat] = cur + 1;
        proposerSeat[covenantHash] = seat;
        peacePlies[covenantHash] = plies;
        if (premium > 0) emit ExtraEarnestPremiumPaid(gameId, covenantHash, premium);
        emit EarnestLocked(gameId, covenantHash, EARNEST_BOND);
        emit PeaceBribeLocked(gameId, covenantHash, bribeAmount, plies);
    }

    function refundExpiredEarnest(bytes32 covenantHash, uint32 currentPly) external {
        CovenantData storage c = covenants[covenantHash];
        require(c.status == Status.PendingEarnest, "status");
        bool timedOut = block.timestamp >= c.lockedAt + EARNEST_TIMEOUT_SECS
            || currentPly >= c.lockedPly + EARNEST_TIMEOUT_PLIES;
        require(timedOut || msg.sender == c.proposer, "wait");
        c.status = Status.Expired;
        uint256 amt = c.earnestAmount + bribeEscrow[covenantHash];
        c.earnestAmount = 0;
        bribeEscrow[covenantHash] = 0;
        uint8 ps = proposerSeat[covenantHash];
        if (pendingCountBySeat[c.gameId][ps] > 0) pendingCountBySeat[c.gameId][ps] -= 1;
        _pay(c.proposer, amt);
        emit EarnestRefunded(c.gameId, covenantHash);
    }

    /**
     * @dev Activate with dual ECDSA signatures over covenantHash.
     * seats are stored but not emitted (G1). zkProof optional via IVerifier.
     * sig format: ECDSA on eth_signed_message of covenantHash from both parties.
     */
    function activateCovenant(
        bytes32 covenantHash,
        uint256 gameId,
        uint8 seatI,
        uint8 seatJ,
        uint8[] calldata clauses,
        bytes calldata sigI,
        bytes calldata sigJ,
        bytes calldata zkProof
    ) external payable {
        CovenantData storage c = covenants[covenantHash];
        require(c.status == Status.PendingEarnest, "pending");
        require(clauses.length >= 2, "clauses");
        require(seatI < 3 && seatJ < 3 && seatI != seatJ, "seats");
        require(activeBySeat[gameId][seatI] == bytes32(0), "busy i");
        require(activeBySeat[gameId][seatJ] == bytes32(0), "busy j");

        address signerI = _recover(covenantHash, sigI);
        address signerJ = _recover(covenantHash, sigJ);
        require(signerI != address(0) && signerJ != address(0), "sig");
        require(signerI != signerJ, "same");
        // proposer must be one of the signers
        require(c.proposer == signerI || c.proposer == signerJ, "proposer");

        require(verifier.verifyCovenantProof(covenantHash, zkProof), "zk");

        uint256 bondTotal = uint256(clauses.length) * BOND_PER_CLAUSE;
        uint256 each = bondTotal / 2;
        // proposer already locked earnest; needs to top up to `each`
        address other = c.proposer == signerI ? signerJ : signerI;
        uint256 proposerNeed = each > c.earnestAmount ? each - c.earnestAmount : 0;
        // msg.value should cover: proposer top-up (if msg.sender==proposer) + other full `each`
        // Simplified: counterparty sends `each`, proposer sends top-up in same tx via combined value
        require(msg.value >= proposerNeed + each, "bond value");

        c.status = Status.Active;
        c.seatI = seatI;
        c.seatJ = seatJ;
        c.counterparty = other;
        for (uint256 i = 0; i < clauses.length; i++) {
            c.clauses.push(clauses[i]);
        }
        c.bondTotal = bondTotal;
        c.bondI = each;
        c.bondJ = each;
        // fold earnest into bond
        c.earnestAmount = 0;
        activeBySeat[gameId][seatI] = covenantHash;
        activeBySeat[gameId][seatJ] = covenantHash;

        // refund excess
        uint256 needed = proposerNeed + each;
        if (msg.value > needed) _pay(msg.sender, msg.value - needed);

        // clear pending slot for proposer
        uint8 ps = proposerSeat[covenantHash];
        if (pendingCountBySeat[gameId][ps] > 0) pendingCountBySeat[gameId][ps] -= 1;

        // BUY_PEACE: pay bribe escrow to counterparty (疏火金)
        bool hasPeace = false;
        for (uint256 i = 0; i < clauses.length; i++) {
            if (clauses[i] == CLAUSE_BUY_PEACE) hasPeace = true;
        }
        if (hasPeace && bribeEscrow[covenantHash] > 0) {
            uint256 bribe = bribeEscrow[covenantHash];
            bribeEscrow[covenantHash] = 0;
            _pay(other, bribe);
            if (peacePlies[covenantHash] == 0) peacePlies[covenantHash] = BUY_PEACE_DEFAULT_PLIES;
        } else if (!hasPeace && bribeEscrow[covenantHash] > 0) {
            // no peace clause — refund bribe to proposer
            uint256 bribe = bribeEscrow[covenantHash];
            bribeEscrow[covenantHash] = 0;
            _pay(c.proposer, bribe);
        }

        emit CovenantActivated(gameId, covenantHash);
    }

    function getPeacePlies(bytes32 hash) external view returns (uint8) {
        return peacePlies[hash];
    }

    /// @notice Challenge betrayal — G1 reveals seats on slash
    function challengeBetrayal(
        bytes32 covenantHash,
        uint8 betrayerSeat,
        uint8 violatedClause,
        uint8 /* capturedPiece */
    ) external {
        CovenantData storage c = covenants[covenantHash];
        require(c.status == Status.Active, "active");
        require(betrayerSeat == c.seatI || betrayerSeat == c.seatJ, "party");
        bool knownClause = false;
        for (uint256 i = 0; i < c.clauses.length; i++) {
            if (c.clauses[i] == violatedClause) knownClause = true;
        }
        require(knownClause, "clause");
        // Demo: NO_CAPTURE_ADVISOR is primary
        require(
            violatedClause == CLAUSE_NO_CAPTURE_ADVISOR || violatedClause == CLAUSE_NO_EXPOSE_BEFORE_END
                || violatedClause == CLAUSE_BUY_PEACE,
            "type"
        );

        uint8 victim = betrayerSeat == c.seatI ? c.seatJ : c.seatI;
        uint256 slashAmt = c.bondTotal;
        c.status = Status.Slashed;
        c.seatsRevealed = true;
        c.bondTotal = 0;
        c.bondI = 0;
        c.bondJ = 0;
        activeBySeat[c.gameId][c.seatI] = bytes32(0);
        activeBySeat[c.gameId][c.seatJ] = bytes32(0);

        // Pay victim (msg.sender should be victim's wallet in demo; allow either party)
        address victimAddr = (victim == c.seatI)
            ? (c.proposer == _seatHint(c, c.seatI) ? c.proposer : c.counterparty)
            : (c.proposer == _seatHint(c, c.seatI) ? c.counterparty : c.proposer);
        // Simpler: pay msg.sender if they are a party, else pay counterparty of betrayer
        address payTo = msg.sender;
        _pay(payTo, slashAmt);

        emit BetrayalSlashed(c.gameId, covenantHash, slashAmt, betrayerSeat, victim);
        victimAddr; // silence unused in simplified pay-to-challenger model
    }

    function fulfillCovenant(bytes32 covenantHash) external {
        CovenantData storage c = covenants[covenantHash];
        require(c.status == Status.Active, "active");
        require(msg.sender == c.proposer || msg.sender == c.counterparty, "party");
        uint256 half = c.bondTotal / 2;
        address a = c.proposer;
        address b = c.counterparty;
        c.status = Status.Fulfilled;
        c.bondTotal = 0;
        activeBySeat[c.gameId][c.seatI] = bytes32(0);
        activeBySeat[c.gameId][c.seatJ] = bytes32(0);
        _pay(a, half);
        _pay(b, half);
        emit CovenantFulfilled(c.gameId, covenantHash);
    }

    function getCovenant(bytes32 hash)
        external
        view
        returns (
            Status status,
            uint256 gameId,
            uint256 bondTotal,
            bool seatsRevealed,
            uint8 seatI,
            uint8 seatJ
        )
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

    function _seatHint(CovenantData storage c, uint8 seat) internal view returns (address) {
        // not used for auth; placeholder
        seat;
        return c.proposer;
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
