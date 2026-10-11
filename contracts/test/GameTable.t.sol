// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract GameTableTest is Test {
    GameTable game;
    AgentRegistry reg;
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
        reg = new AgentRegistry();
        game = new GameTable(address(reg));
        reg.setGameTable(address(game));
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

    function _move(uint256 id, uint256 key, uint8 seat, uint8 fx, uint8 fy, uint8 tx, uint8 ty, uint8 piece) internal {
        bytes32 salt = keccak256(abi.encode(seat, fx, fy, tx, ty, piece, key));
        bytes32 ch = keccak256(abi.encode(seat, fx, fy, tx, ty, piece, salt));
        address who = vm.addr(key);
        vm.prank(who);
        game.commitMove(id, ch);
        vm.prank(who);
        game.revealMove(id, fx, fy, tx, ty, piece, salt);
    }

    function test_JoinAndStart() public {
        uint256 id = _start();
        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Playing));
    }

    function test_CreateAndJoinHideAi() public {
        vm.recordLogs();
        uint256 id = game.createGame(2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].data.length, 0);

        vm.recordLogs();
        vm.prank(a);
        game.join{value: 3 ether}(id, 0);
        logs = vm.getRecordedLogs();
        assertEq(logs[0].data.length, 64);
    }

    function test_CommitRevealChargesFee() public {
        uint256 id = _start();
        _move(id, keyA, 0, 5, 7, 5, 6, 7);
        (,, uint256 play,,) = game.getSeat(id, 0);
        assertEq(play, 2 ether - 0.009 ether);
    }

    function test_ChariotBlockedBySoldier() public {
        uint256 id = _start();
        bytes32 salt = bytes32(uint256(7));
        bytes32 ch = keccak256(abi.encode(uint8(0), uint8(7), uint8(10), uint8(7), uint8(3), uint8(5), salt));
        vm.prank(a);
        game.commitMove(id, ch);
        vm.prank(a);
        vm.expectRevert(bytes("illegal geom"));
        game.revealMove(id, 7, 10, 7, 3, 5, salt);
    }

    function test_CaptureHorsePointsAndPenalty() public {
        uint256 id = _start();
        _move(id, keyA, 0, 5, 7, 5, 6, 7);
        _move(id, keyB, 1, 3, 1, 4, 1, 7);
        _move(id, keyC, 2, 6, 9, 4, 10, 4); // horse takes advisor, +30
        _move(id, keyA, 0, 5, 10, 4, 10, 1); // general takes horse, +50

        (,,, uint32 ptsA,) = game.getSeat(id, 0);
        (,, uint256 playC, uint32 ptsC,) = game.getSeat(id, 2);
        assertEq(ptsA, 50);
        assertEq(ptsC, 5); // 30 - 25
        // horse move fee 0.03 then capture penalty 0.05
        assertEq(playC, 2 ether - 0.03 ether - 0.05 ether);
    }

    function test_DefeatSeizesPointsAndStake() public {
        uint256 id = _start();
        _move(id, keyA, 0, 7, 7, 8, 7, 7); // clear file for chariot
        _move(id, keyB, 1, 3, 1, 4, 1, 7);
        _move(id, keyC, 2, 6, 9, 4, 8, 4);
        _move(id, keyA, 0, 7, 10, 7, 3, 5); // chariot takes soldier, +10
        _move(id, keyB, 1, 1, 3, 1, 4, 7);
        _move(id, keyC, 2, 4, 8, 5, 10, 4); // horse takes general

        (,,, uint32 ptsA, bool elimA) = game.getSeat(id, 0);
        (,, uint256 playC, uint32 ptsC,) = game.getSeat(id, 2);
        (,,,,, uint256 pool) = game.getGameMeta(id);
        assertTrue(elimA);
        assertEq(ptsA, 0);
        assertEq(ptsC, 10);
        assertEq(pool, 0.6 ether);
        // two horse steps at 0.03, soldier penalty already taken, plus 0.4 stake
        assertEq(playC, 2 ether - 0.03 ether - 0.01 ether - 0.03 ether + 0.4 ether);
    }

    function test_ExpireCommitPenalty() public {
        uint256 id = _start();
        bytes32 salt = bytes32(uint256(9));
        bytes32 ch = keccak256(abi.encode(uint8(0), uint8(5), uint8(7), uint8(5), uint8(6), uint8(7), salt));
        vm.prank(a);
        game.commitMove(id, ch);
        vm.warp(block.timestamp + 59);
        vm.expectRevert(bytes("window"));
        game.expireCommit(id);
        vm.warp(block.timestamp + 2);
        game.expireCommit(id);
        (,, uint256 play,,) = game.getSeat(id, 0);
        assertEq(play, 2 ether - 0.03 ether);
        (, uint8 turn,,,,) = game.getGameMeta(id);
        assertEq(turn, 1);
    }

    function test_DirectorDrainBankrupt() public {
        uint256 id = _start();
        game.directorDrain(id, 0, 2 ether);
        (,,,, bool elim) = game.getSeat(id, 0);
        assertTrue(elim);
    }

    function test_FinalizeSeventyTwentyTen() public {
        uint256 id = _start();
        uint256 bBefore = b.balance;
        uint256 cBefore = c.balance;
        game.directorDrain(id, 0, 2 ether);
        game.directorDrain(id, 1, 2 ether);
        game.finalizeGame(id, keccak256("motive"));
        assertEq(c.balance - cBefore, 4.4 ether); // 70% of 2 + stake 1 + play 2
        assertEq(b.balance - bBefore, 0.4 ether); // 20% of 2
        assertEq(address(game).balance, 4.2 ether); // stuck play 4 + 10% of 2
    }
}
