// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract DepositTest is Test {
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
        vm.prank(a); game.join{value: 3 ether}(id, 0);
        vm.prank(b); game.join{value: 3 ether}(id, 1);
        vm.prank(cAi); game.join{value: 3 ether}(id, 2);

        vm.prank(a);
        game.depositPlayBalance{value: 1 ether}(id, 0);
        (,, uint256 play,,) = game.getSeat(id, 0);
        assertEq(play, 3 ether);

        vm.prank(cAi);
        vm.expectRevert(bytes("ai no topup"));
        game.depositPlayBalance{value: 1 ether}(id, 2);
    }
}
