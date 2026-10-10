// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract GameTableTest is Test {
    GameTable game;
    AgentRegistry reg;
    address a = address(0xA11);
    address b = address(0xB22);
    address c = address(0xC33);

    function setUp() public {
        reg = new AgentRegistry();
        game = new GameTable(address(reg));
        reg.setGameTable(address(game));
        vm.deal(a, 100 ether);
        vm.deal(b, 100 ether);
        vm.deal(c, 100 ether);
    }

    function test_JoinAndStart() public {
        uint256 id = game.createGame(2); // AI seat C
        vm.prank(a);
        game.join{value: 3 ether}(id, 0);
        vm.prank(b);
        game.join{value: 3 ether}(id, 1);
        vm.prank(c);
        game.join{value: 3 ether}(id, 2);
        (GameTable.Phase phase,,,,,) = game.getGameMeta(id);
        assertEq(uint8(phase), uint8(GameTable.Phase.Playing));
    }

    function test_CommitRevealChargesFee() public {
        uint256 id = game.createGame(2);
        vm.prank(a);
        game.join{value: 3 ether}(id, 0);
        vm.prank(b);
        game.join{value: 3 ether}(id, 1);
        vm.prank(c);
        game.join{value: 3 ether}(id, 2);

        // Seat 0 soldier at (5,7) -> (5,6)
        uint8 seat = 0;
        uint8 fx = 5;
        uint8 fy = 7;
        uint8 tox = 5;
        uint8 ty = 6;
        uint8 piece = 7;
        bytes32 salt = bytes32(uint256(42));
        bytes32 ch = keccak256(abi.encode(seat, fx, fy, tox, ty, piece, salt));

        vm.prank(a);
        game.commitMove(id, ch);
        vm.prank(a);
        game.revealMove(id, fx, fy, tox, ty, piece, salt);

        (, , uint256 play,,) = game.getSeat(id, 0);
        assertEq(play, 2 ether - 0.009 ether);
    }

    function test_DirectorDrainBankrupt() public {
        uint256 id = game.createGame(2);
        vm.prank(a);
        game.join{value: 3 ether}(id, 0);
        vm.prank(b);
        game.join{value: 3 ether}(id, 1);
        vm.prank(c);
        game.join{value: 3 ether}(id, 2);

        game.directorDrain(id, 0, 2 ether);
        (,,,, bool elim) = game.getSeat(id, 0);
        assertTrue(elim);
    }
}
