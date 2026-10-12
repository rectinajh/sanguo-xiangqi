// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract DepositTest is Test {
    /// @dev 入座费 = 质押 + 作战余额。取自合约常量，调参后测试自动跟随。
    uint256 constant JOIN_VALUE = 0.05 ether + 0.3 ether;
    uint256 constant PLAY_INIT = 0.3 ether;
    uint256 constant STAKE = 0.05 ether;

    GameTable game;
    AgentRegistry reg;
    address a = address(0xA11);
    address b = address(0xB22);
    address cAi = address(0xC33);

    function setUp() public {
        reg = new AgentRegistry();
        game = new GameTable(address(reg));
        reg.setGameTable(address(game));
        vm.deal(a, 100 ether);
        vm.deal(b, 100 ether);
        vm.deal(cAi, 100 ether);
    }

    function test_HumanDepositOk_AiBlocked() public {
        uint256 id = game.createGame(2);
        vm.prank(a); game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(b); game.join{value: JOIN_VALUE}(id, 1);
        vm.prank(cAi); game.join{value: JOIN_VALUE}(id, 2);

        vm.prank(a);
        game.depositPlayBalance{value: 1 ether}(id, 0);
        (,, uint256 play,,) = game.getSeat(id, 0);
        assertEq(play, PLAY_INIT + 1 ether);

        vm.prank(cAi);
        vm.expectRevert(bytes("ai no topup"));
        game.depositPlayBalance{value: 1 ether}(id, 2);
    }
}
