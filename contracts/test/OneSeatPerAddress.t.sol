// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @dev 同一地址只能占一个座位。
///
/// 为什么必须拦：否则一个人能自己坐满三席、自己跟自己下 —— 可以刷战绩、
/// 刷 AgentRegistry 声誉，也能用两个座位互相"背刺"来套诚意金。
/// 三人博弈的前提是三方独立。
/// 顺带修掉一个隐患：`_seatOf` 只返回第一个匹配座位，占多座时
/// abandonGame 会算错该退给谁。
contract OneSeatPerAddressTest is Test {
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

    function test_SameAddressCannotTakeTwoSeats() public {
        uint256 id = game.createGame();
        vm.prank(a);
        game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(a);
        vm.expectRevert(bytes("one seat per address"));
        game.join{value: JOIN_VALUE}(id, 1);
    }

    /// 退掉重坐也不允许：合约没有"退座"，所以这条约束一旦违反就无法自愈。
    function test_ThirdSeatAlsoBlocked() public {
        uint256 id = game.createGame();
        vm.prank(a);
        game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(a);
        vm.expectRevert(bytes("one seat per address"));
        game.join{value: JOIN_VALUE}(id, 2);
    }

    /// 不同地址仍能正常坐满三席并开局。
    function test_DifferentAddressesStillStart() public {
        uint256 id = game.createGame();
        vm.prank(a);
        game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(b);
        game.join{value: JOIN_VALUE}(id, 1);
        vm.prank(c);
        game.join{value: JOIN_VALUE}(id, 2);
        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Playing), "should start");
    }

    /// 约束按"局"生效：同一个人可以在不同局里各坐一席（不同 gameId 互不影响）。
    function test_SameAddressAllowedInDifferentGames() public {
        uint256 id1 = game.createGame();
        uint256 id2 = game.createGame();
        vm.startPrank(a);
        game.join{value: JOIN_VALUE}(id1, 0);
        game.join{value: JOIN_VALUE}(id2, 0);
        vm.stopPrank();
        (address p1,,,,) = game.getSeat(id1, 0);
        (address p2,,,,) = game.getSeat(id2, 0);
        assertEq(p1, a);
        assertEq(p2, a);
    }
}
