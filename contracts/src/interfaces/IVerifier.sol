// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ZK-ready interface. StubVerifier = ECDSA-only path (NOT full ZK).
interface IVerifier {
    /// @dev P0: may ignore zkProof and only check ECDSA-style payload authenticity off-path.
    /// P1: verify snark for covenant preimage knowledge without revealing seats.
    function verifyCovenantProof(
        bytes32 covenantHash,
        bytes calldata zkProof
    ) external view returns (bool);
}
