// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {Covenant} from "../src/Covenant.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {StubVerifier} from "../src/verifiers/StubVerifier.sol";

contract CovenantTest is Test {
    Covenant cov;
    GameTable game;
    AgentRegistry reg;
    StubVerifier ver;
    uint256 keyA = 0xA11;
    uint256 keyB = 0xB22;
    uint256 keyC = 0xC33;
    address a;
    address b;
    address c;

    function setUp() public {
        a = vm.addr(keyA);
        b = vm.addr(keyB);
        c = vm.addr(keyC);
        ver = new StubVerifier();
        reg = new AgentRegistry();
        game = new GameTable(address(reg));
        cov = new Covenant(address(ver));
        reg.setGameTable(address(game));
        cov.setGameTable(address(game));
        game.setCovenant(address(cov));
        // 给足余额：本文件里同一个地址要反复 join(3 MON) + 锁诚意金 + 付 bond，
        // 余额不足会表现为 challengeBetrayal 里的 OutOfFunds，而不是断言失败。
        vm.deal(a, 10_000 ether);
        vm.deal(b, 10_000 ether);
        vm.deal(c, 10_000 ether);
    }

    function _start() internal returns (uint256 id) {
        id = game.createGame(2);
        vm.prank(a);
        game.join{value: 3 ether}(id, 0);
        vm.prank(b);
        game.join{value: 3 ether}(id, 1);
        vm.prank(c);
        game.join{value: 3 ether}(id, 2);
        // 声誉注册表不再自动注册陌生地址，AI 座位要显式注册，否则
        // finalizeGame 里的 recordGameResult 会被 catch 吞掉、声誉写不进去。
        vm.prank(c);
        reg.registerAgent("ipfs://agent");
    }

    function _sigs(bytes32 hash, uint256 k1, uint256 k2) internal view returns (bytes memory sigI, bytes memory sigJ) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(k1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(k2, digest);
        sigI = abi.encodePacked(r1, s1, v1);
        sigJ = abi.encodePacked(r2, s2, v2);
    }

    function _move(uint256 id, uint256 key, uint8 seat, uint8 fx, uint8 fy, uint8 tx, uint8 ty, uint8 piece) internal {
        bytes32 salt = keccak256(abi.encode("m", seat, fx, fy, tx, ty));
        bytes32 ch = keccak256(abi.encode(seat, fx, fy, tx, ty, piece, salt));
        address who = vm.addr(key);
        vm.prank(who);
        game.commitMove(id, ch);
        vm.prank(who);
        game.revealMove(id, fx, fy, tx, ty, piece, salt);
    }

    function _clauses() internal pure returns (uint8[] memory clauses) {
        clauses = new uint8[](2);
        clauses[0] = 1;
        clauses[1] = 2;
    }

    function _peaceClauses() internal pure returns (uint8[] memory clauses) {
        clauses = new uint8[](2);
        clauses[0] = 4;
        clauses[1] = 1;
    }

    /// @dev 构造 preimage：先按内容算 hash，再把 hash 写回 nonce 字段。
    ///      这样链下可以在不知道 nonce 的前提下先算出 hash 并签名/锁诚意金。
    function mkHash(uint8[] memory clauses, uint256 gameId, uint8 si, uint8 sj, uint256 bond)
        internal
        pure
        returns (bytes32 h)
    {
        Covenant.CovenantPreimage memory p;
        p.gameId = gameId;
        p.seatI = si;
        p.seatJ = sj;
        p.clauses = clauses;
        p.bondAmount = bond;
        p.earnestBond = 0.1 ether;
        h = keccak256(abi.encode(p));
        p.nonce = h;
        return keccak256(abi.encode(p));
    }

    function mkPre(uint8[] memory clauses, uint256 gameId, uint8 si, uint8 sj, uint256 bond)
        internal
        pure
        returns (Covenant.CovenantPreimage memory p)
    {
        p.gameId = gameId;
        p.seatI = si;
        p.seatJ = sj;
        p.clauses = clauses;
        p.bondAmount = bond;
        p.earnestBond = 0.1 ether;
        p.nonce = keccak256(abi.encode(p));
    }

    /// @dev 用 gameTable 上真实的座位地址反推 preimage 里的 seatI/seatJ。
    ///      关键：座位必须与【真正签名的两把钥】对应 —— seatI 配 a1，seatJ 配 a2。
    ///      preimage 里写错座位会让合约里的 pI/pJ 指向空座或错误的人，
    ///      表现为"当事人校验通过但 counterparty 落回自己那一座"。
    function actualSeats(uint256 gameId, uint256 a1, uint256 a2)
        internal
        view
        returns (uint8 si, uint8 sj, address pI, address pJ)
    {
        for (uint8 s = 0; s < 3; s++) {
            (address pl,,,,) = game.getSeat(gameId, s);
            if (pl == vm.addr(a1)) si = s;
            if (pl == vm.addr(a2)) sj = s;
        }
        (pI,,,,) = game.getSeat(gameId, si);
        (pJ,,,,) = game.getSeat(gameId, sj);
    }

    function test_LockActivateSlashRequiresCapture() public {
        uint256 id = _start();
        (uint8 si, uint8 sj, address pI, address pJ) = actualSeats(id, keyA, keyC);
        uint8[] memory cl = _clauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);
        Covenant.CovenantPreimage memory p = mkPre(cl, id, si, sj, 0.3 ether);

        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, si);

        (bytes memory sigA, bytes memory sigC) = _sigs(hash, keyA, keyC);
        // 发起方是 seat 2（c），由 c 自己激活：c 付自己的 0.15，
        // a 已锁的 0.1 诚意金抵扣 a 那一半，a 还需补 0.05（由 a 自己补，见下测）。
        vm.prank(c);
        cov.activateCovenant{value: 0.2 ether}(p, sigA, sigC, ""); // 自己那半 + 替发起方补齐

        vm.prank(a);
        vm.expectRevert(bytes("no capture"));
        cov.challengeBetrayal(hash, sj, 1);

        _move(id, keyA, 0, 5, 7, 5, 6, 7);
        _move(id, keyB, 1, 3, 1, 4, 1, 7);
        _move(id, keyC, 2, 6, 9, 4, 10, 4);

        (,, uint256 playBefore,,) = game.getSeat(id, si);
        vm.prank(a);
        cov.challengeBetrayal(hash, sj, 1);
        (Covenant.Status st,,,, uint8 seatI, uint8 seatJ) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Slashed));
        assertTrue(seatI != 255 && seatJ != 255);
        (,, uint256 playAfter,,) = game.getSeat(id, si);
        assertEq(playAfter, playBefore + 0.3 ether);
        assertTrue(game.seatWasSlashed(id, sj));

        game.directorDrain(id, 1, 5 ether);
        game.directorDrain(id, 2, 5 ether);
        game.finalizeGame(id, keccak256("motive"));

        uint256 forced = game.feesPaidOf(id, 0) + game.feesPaidOf(id, 1);
        assertGt(forced, 0);
        AgentRegistry.Reputation memory rep = reg.getReputation(c);
        assertEq(rep.slashed, 1);
        assertEq(rep.forcedBurnMonTotal, forced);
        pI;
        pJ;
    }

    function test_NonEmptyProofRejectedOnFreshCovenant() public {
        uint256 id = _start();
        (uint8 si, uint8 sj,,) = actualSeats(id, keyA, keyB);
        uint8[] memory cl = _clauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);
        Covenant.CovenantPreimage memory p = mkPre(cl, id, si, sj, 0.3 ether);

        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, si);
        (bytes memory sigA, bytes memory sigB) = _sigs(hash, keyA, keyB);
        vm.prank(b);
        vm.expectRevert(bytes("zk"));
        cov.activateCovenant(p, sigA, sigB, hex"dead");
    }

    function test_WhaleMultiPendingEarnest() public {
        uint256 id = _start();
        vm.prank(a);
        game.depositPlayBalance{value: 1.5 ether}(id, 0);
        vm.startPrank(a);
        cov.lockEarnest{value: 0.1 ether}(id, keccak256("a"), 0);
        cov.lockEarnest{value: 0.15 ether}(id, keccak256("b"), 0);
        cov.lockEarnest{value: 0.15 ether}(id, keccak256("c"), 0);
        vm.expectRevert(bytes("pending cap"));
        cov.lockEarnest{value: 0.15 ether}(id, keccak256("d"), 0);
        vm.stopPrank();
        assertEq(cov.pendingCount(id, 0), 3);
    }

    function test_BudgetCapIsOne() public {
        uint256 id = _start();
        vm.startPrank(a);
        cov.lockEarnest{value: 0.1 ether}(id, keccak256("x"), 0);
        vm.expectRevert(bytes("pending cap"));
        cov.lockEarnest{value: 0.15 ether}(id, keccak256("y"), 0);
        vm.stopPrank();
    }

    function test_BuyPeaceOffer() public {
        uint256 id = _start();
        (uint8 si, uint8 sj,,) = actualSeats(id, keyA, keyB);
        uint8[] memory cl = _peaceClauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);
        Covenant.CovenantPreimage memory p = mkPre(cl, id, si, sj, 0.3 ether);

        vm.prank(a);
        cov.lockPeaceOffer{value: 0.1 ether + 0.25 ether}(id, hash, si, 0.25 ether, 8);
        assertEq(cov.getPeacePlies(hash), 8);

        (bytes memory sigA, bytes memory sigB) = _sigs(hash, keyA, keyB);
        uint256 before = b.balance;
        // 由对手方 b 激活：b 付 0.2（自己那半 0.15 + 替发起方 a 补齐 0.05），
        // 同时收到贿金 0.25 → 净变化 +0.05。
        vm.prank(b);
        cov.activateCovenant{value: 0.2 ether}(p, sigA, sigB, "");
        assertEq(b.balance, before + 0.05 ether);
        (Covenant.Status st,,,,,) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Active));
    }

    /// @dev H3 回归：谁付多少只看身份，不看谁在调用。
    function test_ActivateChargesByCallerIdentity() public {
        uint256 id = _start();
        (uint8 si, uint8 sj,,) = actualSeats(id, keyA, keyC);
        uint8[] memory cl = _clauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);
        Covenant.CovenantPreimage memory p = mkPre(cl, id, si, sj, 0.3 ether);

        // a 是发起方，锁了 0.1 诚意金，还差 0.05 才够它那一半
        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, si);
        (bytes memory sigA, bytes memory sigC) = _sigs(hash, keyA, keyC);

        // 发起方 a 调用：只需补 0.05，不能被迫出对手方的 0.15
        uint256 aBefore = a.balance;
        vm.prank(a);
        cov.activateCovenant{value: 0.05 ether}(p, sigA, sigC, "");
        assertEq(a.balance, aBefore - 0.05 ether);
        (Covenant.Status st,,,,,) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Active));
    }

    /// @dev H3 回归：非当事人不能出资激活别人的盟约。
    function test_ActivateRejectsNonPartyCaller() public {
        uint256 id = _start();
        (uint8 si, uint8 sj,,) = actualSeats(id, keyA, keyC);
        uint8[] memory cl = _clauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);
        Covenant.CovenantPreimage memory p = mkPre(cl, id, si, sj, 0.3 ether);

        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, si);
        (bytes memory sigA, bytes memory sigC) = _sigs(hash, keyA, keyC);

        // b 既不是 seatI 也不是 seatJ，不能替他们激活
        vm.prank(b);
        vm.expectRevert(bytes("caller not party"));
        cov.activateCovenant{value: 0.3 ether}(p, sigA, sigC, "");
    }

    /// @dev B2 回归：背刺者不能抢在受害方之前用 fulfillCovenant 逃掉罚没。
    function test_BetrayerCannotEscapeViaFulfill() public {
        uint256 id = _start();
        (uint8 si, uint8 sj,,) = actualSeats(id, keyA, keyC);
        assertEq(si, 0, "si should be seat of a");
        assertEq(sj, 2, "sj should be seat of c");
        {
            (address s0,,,,) = game.getSeat(id, 0);
            (address s1,,,,) = game.getSeat(id, 1);
            (address s2,,,,) = game.getSeat(id, 2);
            assertEq(s0, vm.addr(keyA), "seat0 = a");
            assertEq(s1, vm.addr(keyB), "seat1 = b");
            assertEq(s2, vm.addr(keyC), "seat2 = c");
        }
        uint8[] memory cl = _clauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);
        Covenant.CovenantPreimage memory p = mkPre(cl, id, si, sj, 0.3 ether);
        assertEq(p.seatI, 0, "pre seatI");
        assertEq(p.seatJ, 2, "pre seatJ");

        // 让背刺者 c（seat 2）当发起方：由它锁诚意金、由它吃盟友的士，
        // 再由它自己调用 fulfillCovenant 试图跑掉 —— 这就是真实攻击路径。
        // 受害方 a（seat 0）来激活盟约（付它那一半 bond）。
        vm.prank(c);
        cov.lockEarnest{value: 0.1 ether}(id, hash, sj); // sj = c 自己的座位
        (bytes memory sigA, bytes memory sigC) = _sigs(hash, keyA, keyC);
        vm.prank(a);
        cov.activateCovenant{value: 0.2 ether}(p, sigA, sigC, ""); // 0.15 自己那半 + 0.05 替发起方补齐

        // 制造真实的"吃盟友士"证据：绿方（c）的马吃红方（a）的士
        _move(id, keyA, 0, 5, 7, 5, 6, 7);
        _move(id, keyB, 1, 3, 1, 4, 1, 7);
        _move(id, keyC, 2, 6, 9, 4, 10, 4);

        // 记录角色：seatI/seatJ 由 actualSeats 反推，preimage 里 seatI 对应签名里的 a
        // 合约契约：proposer = 锁诚意金的人（c）；counterparty = 另一方（a）。
        // 用当事人身份读取（partiesOfHash 对第三方返回全零，见 B3 回归测试）。
        {
            vm.prank(c);
            (address pr_, address cp_) = cov.partiesOfHash(hash);
            assertEq(pr_, vm.addr(keyC), "proposer should be c");
            assertEq(cp_, vm.addr(keyA), "counterparty should be a");
        }
        // 背刺者（吃士的 c）自己来跑 fulfill —— 必须被拒
        vm.prank(vm.addr(keyC));
        vm.expectRevert(bytes("violation pending"));
        cov.fulfillCovenant(hash);

        // 发起方 a 是受害方，仍然可以正常 Slash（受害方 = 被吃士的一方 = a）
        vm.prank(vm.addr(keyA));
        cov.challengeBetrayal(hash, sj, 1);
        (Covenant.Status st,,,,,) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Slashed));
        assertTrue(game.seatWasSlashed(id, sj));
    }

    /// @dev B3 回归：第三方读不到盟约当事人。
    function test_ActiveCovenantPartiesNotPubliclyReadable() public {
        uint256 id = _start();
        (uint8 si, uint8 sj,,) = actualSeats(id, keyA, keyC);
        uint8[] memory cl = _clauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);
        Covenant.CovenantPreimage memory p = mkPre(cl, id, si, sj, 0.3 ether);

        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, si);
        (bytes memory sigA, bytes memory sigC) = _sigs(hash, keyA, keyC);
        vm.prank(c);
        cov.activateCovenant{value: 0.2 ether}(p, sigA, sigC, ""); // 自己那半 + 替发起方补齐

        // 只有"这个座有没有生效盟约"是公开的
        assertTrue(cov.hasActive(id, si));
        assertTrue(cov.hasActive(id, sj));
        assertFalse(cov.hasActive(id, 1));

        // 当事人能查到自己的 hash
        vm.prank(a);
        assertEq(cov.partiesOf(id, si), hash);
        vm.prank(c);
        assertEq(cov.partiesOf(id, sj), hash);

        // 第三方查到的必须是空 —— 这就是 G1 的链上边界
        vm.prank(b);
        assertEq(cov.partiesOf(id, si), bytes32(0));
        vm.prank(address(0xBEEF));
        assertEq(cov.partiesOf(id, sj), bytes32(0));

        // getCovenant 也不吐座位
        (,,,, uint8 r0, uint8 r1) = cov.getCovenant(hash);
        assertEq(r0, 255);
        assertEq(r1, 255);
    }

    /// @dev H7b 回归：激活时的条款必须与签名覆盖的 preimage 一致。
    function test_ActivateRejectsTamperedBondAmount() public {
        uint256 id = _start();
        (uint8 si, uint8 sj,,) = actualSeats(id, keyA, keyC);
        uint8[] memory cl = _clauses();
        bytes32 hash = mkHash(cl, id, si, sj, 0.3 ether);

        // 攻击者用同一批签名，但把 bondAmount 改成 10 MON，想抬高自己的 bond
        Covenant.CovenantPreimage memory tampered = mkPre(cl, id, si, sj, 10 ether);
        (bytes memory sigA, bytes memory sigC) = _sigs(hash, keyA, keyC);
        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, si);
        // 篡改后的 preimage 算出的 hash 对不上任何已锁盟约，直接 revert。
        // 也就是：签名覆盖的条款不可能被调用者现场替换（H7b）。
        vm.prank(c);
        vm.expectRevert(bytes("pending"));
        cov.activateCovenant(tampered, sigA, sigC, "");
    }

    function test_EarnestTimeoutRefundHidesSeat() public {
        uint256 id = _start();
        bytes32 hash = keccak256("refund");
        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, 0);
        vm.warp(block.timestamp + 91);
        vm.recordLogs();
        cov.refundExpiredEarnest(hash);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // EarnestRefunded(gameId indexed, covenantHash indexed, amount) —— 3 个 topic，
        // data 里只有金额，没有任何座位信息。这就是 G1 退款路径的隐私断言。
        assertEq(logs[0].data.length, 32);
        assertEq(logs[0].topics.length, 3);
        assertEq(abi.decode(logs[0].data, (uint256)), 0.1 ether);
        (Covenant.Status st,,,, uint8 s0, uint8 s1) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Expired));
        assertEq(s0, 255);
        assertEq(s1, 255);
    }
}
