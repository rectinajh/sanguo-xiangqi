// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";

/// @notice ECDSA-only stub. Does NOT claim full ZK.
/// Activation requires dual ECDSA in Covenant; zkProof may be empty.
/// README must label this ZK-ready, not complete ZK.
contract StubVerifier is IVerifier {
    /// @dev Accepts empty proof (ECDSA path already done in Covenant).
    /// Rejects a magic "fake zk" marker to avoid empty return-true abuse in tests of honesty.
    function verifyCovenantProof(bytes32, bytes calldata zkProof) external pure returns (bool) {
        if (zkProof.length == 0) return true; // P0 ECDSA path
        // Reject claimed-fake full ZK blobs that start with "FAKEZK"
        if (zkProof.length >= 6 && bytes6(zkProof[0:6]) == bytes6("FAKEZK")) return false;
        // Future: decode real proof; for now non-empty non-fake is accepted as opaque blob passthrough
        return true;
    }
}
