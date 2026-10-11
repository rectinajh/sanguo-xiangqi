// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Covenant} from "../src/Covenant.sol";

/// @dev 跨语言哈希对照。
/// 链下（frontend/src/lib/contracts.ts 的 encodePreimage / buildPreimage，以及
/// scripts/demo-harness.ts）必须算出与链上完全相同的 covenantHash，否则
/// activateCovenant 会 revert("pending") —— 因为按 hash 找不到已锁的诚意金。
///
/// 这里把 TS 端算出来的值硬编码进来做双向钉死：
///   - 若有人把 TS 端改错（例如把 tuple 展开成扁平参数），这里立刻红
///   - 若有人改了结构体字段或顺序，这里也会红
///
/// 复现方式：node -e 见 scripts/check-preimage-hash.ts
contract PreimageTest is Test {
    /// @dev 对应 TS: encodeAbiParameters([tuple Preimage], [p]) 后 keccak256
    bytes32 constant TS_NONCE = 0x4f1fa5de512280826da1fb9e838b39d5f3be8a3e64df6f11ef4d6bc1d9401390;
    bytes32 constant TS_HASH = 0x7889018c5bd98346125ab6db7006244664bc22ac14deb200aa87174d6086c7f4;

    function _sample() internal pure returns (Covenant.CovenantPreimage memory p) {
        uint8[] memory cl = new uint8[](2);
        cl[0] = 1;
        cl[1] = 2;
        p.gameId = 1;
        p.seatI = 0;
        p.seatJ = 2;
        p.clauses = cl;
        p.bondAmount = 0.3 ether;
        p.earnestBond = 0.1 ether;
        p.nonce = bytes32(0);
        p.validFromPly = 0;
        p.validToPly = 80;
    }

    function test_EncodeMatchesTypeScript() public pure {
        Covenant.CovenantPreimage memory p = _sample();
        bytes32 nonce = keccak256(abi.encode(p));
        assertEq(nonce, TS_NONCE, "nonce (nonce=0) drift vs TS");
        p.nonce = nonce;
        assertEq(keccak256(abi.encode(p)), TS_HASH, "covenantHash drift vs TS");
    }

    /// @dev hashPreimage 是 view 包装，必须与上面的 abi.encode 完全一致。
    function test_HashPreimageHelperMatches() public {
        Covenant cov = new Covenant(address(new StubVerifierLike()));
        Covenant.CovenantPreimage memory p = _sample();
        bytes32 nonce = cov.hashPreimage(p);
        assertEq(nonce, TS_NONCE, "hashPreimage drift");
        p.nonce = nonce;
        assertEq(cov.hashPreimage(p), TS_HASH, "hashPreimage drift (with nonce)");
    }
}

contract StubVerifierLike {
    function verifyCovenantProof(bytes32, bytes calldata) external pure returns (bool) {
        return false;
    }
}
