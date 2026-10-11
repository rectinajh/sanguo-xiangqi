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
        vm.deal(a, 100 ether);
        vm.deal(b, 100 ether);
        vm.deal(c, 100 ether);
    }

    function _start() internal returns (uint256 id) {
        id = game.createGame(2);
        vm.prank(a);
        game.join{value: 3 ether}(id, 0);
        vm.prank(b);
        game.join{value: 3 ether}(id, 1);
        vm.prank(c);
        game.join{value: 3 ether}(id, 2);
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

    function test_LockActivateSlashRequiresCapture() public {
        uint256 id = _start();
        bytes32 hash = keccak256("covenant-demo");
        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, 0);

        (bytes memory sigA, bytes memory sigC) = _sigs(hash, keyA, keyC);
        vm.prank(c);
        cov.activateCovenant{value: 0.2 ether}(hash, id, 0, 2, _clauses(), sigA, sigC, "");

        vm.prank(a);
        vm.expectRevert(bytes("no capture"));
        cov.challengeBetrayal(hash, 2, 1);

        _move(id, keyA, 0, 5, 7, 5, 6, 7);
        _move(id, keyB, 1, 3, 1, 4, 1, 7);
        _move(id, keyC, 2, 6, 9, 4, 10, 4);

        (,, uint256 playBefore,,) = game.getSeat(id, 0);
        vm.prank(a);
        cov.challengeBetrayal(hash, 2, 1);
        (Covenant.Status st,,,, uint8 seatI, uint8 seatJ) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Slashed));
        assertTrue(seatI != 255 && seatJ != 255);
        (,, uint256 playAfter,,) = game.getSeat(id, 0);
        assertEq(playAfter, playBefore + 0.3 ether);
        assertTrue(game.seatWasSlashed(id, 2));

        game.directorDrain(id, 1, 5 ether);
        game.directorDrain(id, 2, 5 ether);
        game.finalizeGame(id, keccak256("motive"));

        uint256 forced = game.feesPaidOf(id, 0) + game.feesPaidOf(id, 1);
        assertGt(forced, 0);
        AgentRegistry.Reputation memory rep = reg.getReputation(c);
        assertEq(rep.slashed, 1);
        assertEq(rep.forcedBurnMonTotal, forced);
    }

    function test_NonEmptyProofRejectedOnFreshCovenant() public {
        uint256 id = _start();
        bytes32 hash = keccak256("zk-reject");
        vm.prank(a);
        cov.lockEarnest{value: 0.1 ether}(id, hash, 0);
        (bytes memory sigA, bytes memory sigB) = _sigs(hash, keyA, keyB);
        vm.prank(b);
        vm.expectRevert(bytes("zk"));
        cov.activateCovenant{value: 0.2 ether}(hash, id, 0, 1, _clauses(), sigA, sigB, hex"dead");
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
        assertEq(cov.pendingCountBySeat(id, 0), 3);
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
        bytes32 hash = keccak256("peace");
        vm.prank(a);
        cov.lockPeaceOffer{value: 0.1 ether + 0.25 ether}(id, hash, 0, 0.25 ether, 8);
        assertEq(cov.getPeacePlies(hash), 8);

        uint8[] memory clauses = new uint8[](2);
        clauses[0] = 4;
        clauses[1] = 1;
        (bytes memory sigA, bytes memory sigB) = _sigs(hash, keyA, keyB);
        uint256 before = b.balance;
        vm.prank(b);
        cov.activateCovenant{value: 0.2 ether}(hash, id, 0, 1, clauses, sigA, sigB, "");
        assertEq(b.balance, before + 0.05 ether);
        (Covenant.Status st,,,,,) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Active));
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
        assertEq(logs[0].data.length, 0);
        assertEq(logs[0].topics.length, 3);
        (Covenant.Status st,,,, uint8 s0, uint8 s1) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Expired));
        assertEq(s0, 255);
        assertEq(s1, 255);
    }
}
