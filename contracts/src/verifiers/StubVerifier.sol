// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../interfaces/IVerifier.sol";

/// @notice ECDSA-only stub. Does NOT claim full ZK.
/// Activation requires dual ECDSA in Covenant; zkProof may be empty.
/// README must label this ZK-ready, not complete ZK.
contract StubVerifier is IVerifier {
    /// @dev Accepts empty proof (ECDSA path already done in Covenant).
    /// Rejects a magic "fake zk" marker to avoid empty return-true abuse in tests of honesty.
    /// @dev Empty proof = P0 ECDSA path (signatures checked in Covenant).
    /// Any non-empty blob is rejected until a real preimage verifier exists.
    function verifyCovenantProof(bytes32, bytes calldata zkProof) external pure returns (bool) {
        return zkProof.length == 0;
    }
}
