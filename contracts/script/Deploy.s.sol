// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StubVerifier} from "../src/verifiers/StubVerifier.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {GameTable} from "../src/GameTable.sol";
import {Covenant} from "../src/Covenant.sol";

contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        vm.startBroadcast(pk);
        StubVerifier verifier = new StubVerifier();
        AgentRegistry registry = new AgentRegistry();
        GameTable table = new GameTable(address(registry));
        registry.setGameTable(address(table));
        Covenant covenant = new Covenant(address(verifier));
        covenant.setGameTable(address(table));
        vm.stopBroadcast();

        console2.log("StubVerifier", address(verifier));
        console2.log("AgentRegistry", address(registry));
        console2.log("GameTable", address(table));
        console2.log("Covenant", address(covenant));
    }
}
