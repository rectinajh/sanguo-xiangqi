// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {StubVerifier} from "../src/verifiers/StubVerifier.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {GameTable} from "../src/GameTable.sol";
import {Covenant} from "../src/Covenant.sol";

/// @notice 部署 GameTable / Covenant / AgentRegistry / StubVerifier 并完成互相接线。
///
/// @dev 部署钥由 CLI 的 `--private-key` 提供（`vm.startBroadcast()` 无参形式会
///      直接使用它）。这里刻意【不】从环境变量读私钥，因为 `forge script` 的
///      环境变量来自 forge 进程自身，而不是 `--private-key` 参数，两者容易脱节。
///
///      调用方（scripts/deploy-*.sh）负责拒绝公开已知的测试钥。历史上这里曾
///      默认使用 Anvil 0 号测试钥（0xac0974be…ff80），而该钥在公网被大量人
///      共用（实测在 Monad 测试网 nonce 已达 468），属于真实资金风险。
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        StubVerifier verifier = new StubVerifier();
        AgentRegistry registry = new AgentRegistry();
        GameTable table = new GameTable(address(registry));
        registry.setGameTable(address(table));
        Covenant covenant = new Covenant(address(verifier));
        covenant.setGameTable(address(table));
        table.setCovenant(address(covenant));
        vm.stopBroadcast();

        console2.log("StubVerifier", address(verifier));
        console2.log("AgentRegistry", address(registry));
        console2.log("GameTable", address(table));
        console2.log("Covenant", address(covenant));
    }
}
