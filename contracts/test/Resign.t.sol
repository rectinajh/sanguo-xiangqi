// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @dev 认输。
///
/// 为什么需要：没有它时唯一能提前结束一局的机制是「等对方 commit 超时 + 清掉」，
/// 而 MAX_PLIES=80、每次超时 60 秒 —— 一局能被拖到接近一小时，钱还锁在合约里
/// 直到终局。三个人里只要有一个中途走了，另外两人只能陪着走完。
contract ResignTest is Test {
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
        id = game.createGame();
        vm.prank(a);
        game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(b);
        game.join{value: JOIN_VALUE}(id, 1);
        vm.prank(c);
        game.join{value: JOIN_VALUE}(id, 2);
    }

    /// 认输者出局，且立刻可以终局结算（不用等 80 手）。
    function test_ResignEliminatesAndAllowsFinalize() public {
        uint256 id = _start();
        vm.prank(b);
        game.resign(id);

        (,,,, bool elim) = game.getSeat(id, 1);
        assertTrue(elim, "resigner eliminated");

        // 关键：不用等 ply>=80 就能结算
        (,, uint32 ply,,,) = game.getGameMeta(id);
        assertLt(ply, game.MAX_PLIES());

        game.finalizeGame(id, keccak256("m"));
        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Finished), "finalized");
    }

    /// 两人认输后，最后一人是胜者。
    function test_LastPlayerWinsWhenOthersResign() public {
        uint256 id = _start();
        vm.prank(a);
        game.resign(id);
        vm.prank(b);
        game.resign(id);

        (GameTable.Phase phase,,, , uint8 winner,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Finished), "auto-finished at 1 alive");
        assertEq(winner, 2, "seat 2 wins");
    }

    /// 已经出局的人不能再认输（否则能重复触发 _bankrupt）。
    function test_CannotResignTwice() public {
        uint256 id = _start();
        vm.prank(b);
        game.resign(id);
        vm.prank(b);
        vm.expectRevert(bytes("out"));
        game.resign(id);
    }

    /// 没入座的人不能替别人认输。
    function test_OutsiderCannotResign() public {
        uint256 id = _start();
        address outsider = vm.addr(0xD44);
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        vm.expectRevert(bytes("not seated"));
        game.resign(id);
    }

    /// 大厅阶段不能"认输"（那该用 abandonGame）。
    function test_CannotResignInLobby() public {
        uint256 id = game.createGame();
        vm.prank(a);
        game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(a);
        vm.expectRevert(bytes("playing"));
        game.resign(id);
    }

    /// 终局后不能再认输。
    function test_CannotResignAfterFinish() public {
        uint256 id = _start();
        vm.prank(a);
        game.resign(id);
        vm.prank(b);
        game.resign(id);
        vm.prank(c);
        vm.expectRevert(bytes("playing"));
        game.resign(id);
    }

    /// 认输与破产走同一条路径：质押进奖池，且金库记账 == 合约余额不变式仍成立。
    function test_ResignFollowsBankruptcyAccounting() public {
        uint256 id = _start();
        uint256 contractBefore = address(game).balance;
        vm.prank(b);
        game.resign(id);

        (, uint256 stakeAfter,,,) = game.getSeat(id, 1);
        assertEq(stakeAfter, 0, "stake moved out of the seat");

        game.finalizeGame(id, keccak256("m"));
        // 结算后：发出去的 + 留在合约里的 == 结算前余额（与破产同一套资金规则）
        assertEq(address(game).balance, game.protocolTreasuryOf(id), "treasury books == residue");
        assertLe(address(game).balance, contractBefore, "contract never pays out more than it held");
    }
}
