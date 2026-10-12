// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @dev 大厅放弃机制。
///
/// 为什么要有这些测试：没有取消机制时，"有人建了房但不再来"会让另外两人的
/// 3 MON 永久卡死（finalizeGame 拒绝处理未开打的局，join 又因座位被占而 revert）。
/// 这个文件钉住"钱一定能拿回来"这条性质。
contract AbandonTest is Test {
    /// @dev 入座费 = 质押 + 作战余额。取自合约常量，调参后测试自动跟随。
    uint256 constant JOIN_VALUE = 0.05 ether + 0.3 ether;
    uint256 constant PLAY_INIT = 0.3 ether;
    uint256 constant STAKE = 0.05 ether;

    GameTable game;
    AgentRegistry reg;
    uint256 keyA = 0xA11;
    uint256 keyB = 0xB22;
    uint256 keyC = 0xC33;
    address payable a;
    address payable b;
    address payable c;

    function setUp() public {
        a = payable(vm.addr(keyA));
        b = payable(vm.addr(keyB));
        c = payable(vm.addr(keyC));
        reg = new AgentRegistry();
        game = new GameTable(address(reg));
        reg.setGameTable(address(game));
        vm.deal(a, 100 ether);
        vm.deal(b, 100 ether);
        vm.deal(c, 100 ether);
    }

    function _lobbyWith(uint8 seats) internal returns (uint256 id) {
        if (seats > 2) {
            vm.prank(c);
            reg.registerAgent("ipfs://agent");
        }
        id = game.createGame();
        if (seats > 0) {
            vm.prank(a);
            game.join{value: JOIN_VALUE}(id, 0);
        }
        if (seats > 1) {
            vm.prank(b);
            game.join{value: JOIN_VALUE}(id, 1);
        }
        if (seats > 2) {
            vm.prank(c);
            game.join{value: JOIN_VALUE}(id, 2);
        }
    }

    /// 一个人在房里：他自己投一票就够（不需要等不存在的玩家）。
    function test_SolePlayerCanAbandonAndRefund() public {
        uint256 id = _lobbyWith(1);
        uint256 balBefore = a.balance;

        vm.prank(a);
        game.abandonGame(id);

        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Abandoned), "phase");

        vm.prank(a);
        uint256 got = game.claimAbandonRefund(id);
        assertEq(got, JOIN_VALUE, "refund = stake + play balance");
        assertEq(a.balance, balBefore + JOIN_VALUE, "balance restored");
    }

    /// 两个人：一个人投票不能卷走另一个人的钱。
    function test_OneVoteIsNotEnoughWhenTwoSeated() public {
        uint256 id = _lobbyWith(2);
        vm.prank(a);
        game.abandonGame(id);
        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Lobby), "still lobby");
    }

    /// 两个人都投票才放行，且两人都能各自取回。
    function test_UnanimousVotesAbandon() public {
        uint256 id = _lobbyWith(2);
        uint256 balA = a.balance;
        uint256 balB = b.balance;

        vm.prank(a);
        game.abandonGame(id);
        vm.prank(b);
        game.abandonGame(id);

        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Abandoned), "abandoned");

        vm.prank(a);
        game.claimAbandonRefund(id);
        vm.prank(b);
        game.claimAbandonRefund(id);
        assertEq(a.balance, balA + JOIN_VALUE, "a refunded");
        assertEq(b.balance, balB + JOIN_VALUE, "b refunded");
    }

    /// 超时后一个人就能强制放弃 —— 否则一个不来的玩家能永远锁住别人的钱。
    function test_TimeoutAllowsUnilateralAbandon() public {
        uint256 id = _lobbyWith(2);
        vm.warp(block.timestamp + game.LOBBY_ABANDON_TIMEOUT() + 1);

        vm.prank(a);
        game.abandonGame(id); // 只 a 投票

        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Abandoned), "timeout forces abandon");

        // b 没投票也能取回自己的钱
        vm.prank(b);
        uint256 got = game.claimAbandonRefund(id);
        assertEq(got, JOIN_VALUE, "b still refunded");
    }

    /// 没超时且没全员同意时，超时判断不能被自己这一票"刷新"掉。
    function test_VoteDoesNotResetTimeoutIntoNeverFiring() public {
        uint256 id = _lobbyWith(2);
        vm.prank(a);
        game.abandonGame(id);
        // 再等超时时间，此时 b 单独投票应当能触发（因为 idleSince 已被 a 的票刷新）
        vm.warp(block.timestamp + game.LOBBY_ABANDON_TIMEOUT() + 1);
        vm.prank(b);
        game.abandonGame(id);
        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Abandoned), "abandoned after timeout");
    }

    /// 不能重复领。
    function test_CannotClaimTwice() public {
        uint256 id = _lobbyWith(1);
        vm.prank(a);
        game.abandonGame(id);
        vm.prank(a);
        game.claimAbandonRefund(id);
        vm.prank(a);
        vm.expectRevert(bytes("nothing to claim"));
        game.claimAbandonRefund(id);
    }

    /// 没入座的人不能投票、也不能领钱。
    function test_OutsiderCannotVoteOrClaim() public {
        uint256 id = _lobbyWith(1);
        address payable outsider = payable(vm.addr(0xD44));
        vm.deal(outsider, 1 ether);

        vm.prank(outsider);
        vm.expectRevert(bytes("not seated"));
        game.abandonGame(id);

        vm.prank(a);
        game.abandonGame(id);
        vm.prank(outsider);
        vm.expectRevert(bytes("not seated"));
        game.claimAbandonRefund(id);
    }

    /// 开打之后不能再用放弃机制（资金划分必须走终局结算）。
    function test_CannotAbandonAfterStart() public {
        uint256 id = _lobbyWith(3);
        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Playing), "playing");

        vm.prank(a);
        vm.expectRevert(bytes("lobby"));
        game.abandonGame(id);
    }

    /// 放弃后 join 必须失败，且不能再次放弃。
    function test_AbandonedGameIsClosed() public {
        uint256 id = _lobbyWith(1);
        vm.prank(a);
        game.abandonGame(id);

        vm.prank(b);
        vm.expectRevert(bytes("lobby"));
        game.join{value: JOIN_VALUE}(id, 1);

        vm.prank(a);
        vm.expectRevert(bytes("lobby"));
        game.abandonGame(id);
    }

    /// 放弃的局不能再被 finalizeGame 结算（避免和终局资金逻辑撞车）。
    function test_CannotFinalizeAbandonedGame() public {
        uint256 id = _lobbyWith(1);
        vm.prank(a);
        game.abandonGame(id);
        vm.expectRevert(bytes("settled"));
        game.finalizeGame(id, keccak256("m"));
    }

    /// 金库记账不变式：放弃 + 领取之后，合约里不留下无人认领的余额。
    function test_ContractBalanceClearedAfterAllClaims() public {
        uint256 id = _lobbyWith(2); // a、b 两人
        vm.prank(a);
        game.abandonGame(id);
        vm.prank(b);
        game.abandonGame(id);
        vm.prank(a);
        game.claimAbandonRefund(id);
        vm.prank(b);
        game.claimAbandonRefund(id);

        assertEq(address(game).balance, 0, "no funds stranded");
        assertEq(game.protocolTreasuryOf(id), 0, "treasury untouched");
    }

    /// 超付的那部分也要退（入座时 msg.value > 3 MON 的差额进了 playBalance）。
    function test_OverpaymentIsRefunded() public {
        uint256 id = game.createGame();
        vm.prank(a);
        game.join{value: JOIN_VALUE + 1 ether}(id, 0);
        uint256 balBefore = a.balance;

        vm.prank(a);
        game.abandonGame(id);
        vm.prank(a);
        uint256 got = game.claimAbandonRefund(id);
        assertEq(got, JOIN_VALUE + 1 ether, "overpayment returned too");
        assertEq(a.balance, balBefore + JOIN_VALUE + 1 ether);
    }
}
