// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @dev 卡住的 commit：有人 commit 后跑路时，任何人都能清掉这一步。
///
/// 为什么重要：没有这个入口时，只要当前行棋方 commit 后不再 reveal，
/// **整局就永久卡死** —— 其他两人既不能走子（回合不推进），也不能结算
/// （finalizeGame 要求 Playing 且存活≤1 或 ply≥80）。前端之前没有入口，
/// 玩家只能干等。
contract StuckCommitTest is Test {
    GameTable game;
    AgentRegistry reg;
    address payable a;
    address payable b;
    address payable c;
    uint256 constant JOIN_VALUE = 0.05 ether + 0.3 ether;

    function setUp() public {
        a = payable(vm.addr(0xA11));
        b = payable(vm.addr(0xB22));
        c = payable(vm.addr(0xC33));
        reg = new AgentRegistry();
        game = new GameTable(address(reg));
        reg.setGameTable(address(game));
        vm.deal(a, 100 ether);
        vm.deal(b, 100 ether);
        vm.deal(c, 100 ether);
    }

    function _start() internal returns (uint256 id) {
        vm.prank(c);
        reg.registerAgent("ipfs://agent");
        id = game.createGame();
        vm.prank(a);
        game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(b);
        game.join{value: JOIN_VALUE}(id, 1);
        vm.prank(c);
        game.join{value: JOIN_VALUE}(id, 2);
    }

    function _commit(uint256 id, uint256 key) internal {
        bytes32 ch = keccak256(abi.encode("c", key));
        vm.prank(vm.addr(key));
        game.commitMove(id, ch);
    }

    /// 没有 pending 时 pendingCommitOf 返回 false。
    function test_NoPendingInitially() public {
        uint256 id = _start();
        (bool pending,, uint256 remaining) = game.pendingCommitOf(id);
        assertFalse(pending);
        assertEq(remaining, 0);
    }

    /// commit 之后能查到 pending，且剩余等待时间 = 窗口时长。
    function test_PendingAfterCommit() public {
        uint256 id = _start();
        _commit(id, 0xA11);
        (bool pending,, uint256 remaining) = game.pendingCommitOf(id);
        assertTrue(pending);
        assertEq(remaining, game.COMMIT_REVEAL_WINDOW());
    }

    /// 窗口内不能清（防止有人立刻把对手的合法走子作废）。
    function test_CannotExpireWithinWindow() public {
        uint256 id = _start();
        _commit(id, 0xA11);
        vm.prank(b);
        vm.expectRevert(bytes("window"));
        game.expireCommit(id);
    }

    /// 窗口过后**任何人**都能清，回合推进到下一座。
    function test_AnyoneCanExpireAfterWindow() public {
        uint256 id = _start();
        _commit(id, 0xA11);
        vm.warp(block.timestamp + game.COMMIT_REVEAL_WINDOW() + 1);

        (bool pending,, uint256 remaining) = game.pendingCommitOf(id);
        assertTrue(pending);
        assertEq(remaining, 0, "remaining should be 0 after window");

        // b 不是行棋方，也能清
        vm.prank(b);
        game.expireCommit(id);

        (bool stillPending,,) = game.pendingCommitOf(id);
        assertFalse(stillPending, "no pending after expire");
        (,, uint32 ply,,,) = game.getGameMeta(id);
        assertEq(ply, 0, "expire is not a move; ply unchanged");
    }

    /// 超时未揭示要被扣惩罚金，且进协议金库。
    function test_TimeoutChargesPenalty() public {
        uint256 id = _start();
        _commit(id, 0xA11);
        (,, uint256 playBefore,,) = game.getSeat(id, 0);
        vm.warp(block.timestamp + game.COMMIT_REVEAL_WINDOW() + 1);
        vm.prank(b);
        game.expireCommit(id);
        (,, uint256 playAfter,,) = game.getSeat(id, 0);
        assertLt(playAfter, playBefore, "timeout seat charged");
        assertGt(game.protocolTreasuryOf(id), 0, "penalty goes to treasury");
    }

    /// 走子（reveal）之后 commit 被清，不会留下"卡住"的假象。
    function test_NoPendingAfterNormalMove() public {
        uint256 id = _start();
        bytes32 salt = keccak256("s");
        bytes32 ch = keccak256(abi.encode(uint8(0), uint8(72), uint8(0), uint8(81), uint8(0), uint8(7), salt));
        vm.prank(a);
        game.commitAndRevealMove(id, 72, 0, 81, 0, 7, salt, ch);
        (bool pending,,) = game.pendingCommitOf(id);
        assertFalse(pending, "no pending after a normal move");
    }
}
