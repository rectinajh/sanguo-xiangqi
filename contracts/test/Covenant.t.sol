// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Covenant} from "../src/Covenant.sol";
import {StubVerifier} from "../src/verifiers/StubVerifier.sol";

contract CovenantTest is Test {
    Covenant cov;
    StubVerifier ver;
    uint256 keyI = 0x1111;
    uint256 keyJ = 0x2222;
    address addrI;
    address addrJ;

    function setUp() public {
        ver = new StubVerifier();
        cov = new Covenant(address(ver));
        addrI = vm.addr(keyI);
        addrJ = vm.addr(keyJ);
        vm.deal(addrI, 50 ether);
        vm.deal(addrJ, 50 ether);
    }

    function _sigs(bytes32 hash) internal view returns (bytes memory sigI, bytes memory sigJ) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(keyI, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(keyJ, digest);
        sigI = abi.encodePacked(r1, s1, v1);
        sigJ = abi.encodePacked(r2, s2, v2);
    }

    function test_LockActivateSlash() public {
        bytes32 hash = keccak256("covenant-demo");
        vm.prank(addrI);
        cov.lockEarnest{value: 0.1 ether}(1, hash, 0, 0, 2 ether);

        uint8[] memory clauses = new uint8[](2);
        clauses[0] = 1;
        clauses[1] = 2;
        (bytes memory sigI, bytes memory sigJ) = _sigs(hash);

        vm.prank(addrJ);
        cov.activateCovenant{value: 0.20 ether}(hash, 1, 0, 1, clauses, sigI, sigJ, "");

        (Covenant.Status st,,,,,) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Active));

        vm.prank(addrI);
        cov.challengeBetrayal(hash, 1, 1, 2);
        (st,,,,,) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Slashed));
    }

    function test_WhaleMultiPendingEarnest() public {
        // whale playBalance hint >= 3 ether => cap 3
        vm.startPrank(addrI);
        cov.lockEarnest{value: 0.1 ether}(1, keccak256("a"), 0, 0, 3 ether);
        // second requires premium 0.05
        cov.lockEarnest{value: 0.15 ether}(1, keccak256("b"), 0, 0, 3 ether);
        cov.lockEarnest{value: 0.15 ether}(1, keccak256("c"), 0, 0, 3 ether);
        vm.expectRevert(bytes("pending cap"));
        cov.lockEarnest{value: 0.15 ether}(1, keccak256("d"), 0, 0, 3 ether);
        vm.stopPrank();
        assertEq(cov.pendingCountBySeat(1, 0), 3);
    }

    function test_BudgetCapIsOne() public {
        vm.startPrank(addrI);
        cov.lockEarnest{value: 0.1 ether}(1, keccak256("x"), 0, 0, 2 ether); // below whale threshold
        vm.expectRevert(bytes("pending cap"));
        cov.lockEarnest{value: 0.15 ether}(1, keccak256("y"), 0, 0, 2 ether);
        vm.stopPrank();
    }

    function test_BuyPeaceOffer() public {
        bytes32 hash = keccak256("peace");
        vm.prank(addrI);
        cov.lockPeaceOffer{value: 0.1 ether + 0.25 ether}(1, hash, 0, 0, 4 ether, 0.25 ether, 8);
        assertEq(cov.getPeacePlies(hash), 8);

        uint8[] memory clauses = new uint8[](2);
        clauses[0] = 4; // BUY_PEACE
        clauses[1] = 1;
        (bytes memory sigI, bytes memory sigJ) = _sigs(hash);
        uint256 before = addrJ.balance;
        vm.prank(addrJ);
        cov.activateCovenant{value: 0.20 ether}(hash, 1, 0, 1, clauses, sigI, sigJ, "");
        // counterparty received bribe 0.25
        assertEq(addrJ.balance, before + 0.05 ether); // paid bond 0.20, got bribe 0.25
        (Covenant.Status st,,,,,) = cov.getCovenant(hash);
        assertEq(uint8(st), uint8(Covenant.Status.Active));
    }
}
