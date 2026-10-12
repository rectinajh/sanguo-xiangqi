// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Mirrors packages/shared/fees.ts — SANREN_RULES §4 步数计费
library FeeLib {
    uint256 internal constant BASE_FEE = 0.01 ether;
    uint256 internal constant DIST_UNIT = 0.005 ether;

    function pieceMultBps(uint8 piece) internal pure returns (uint256) {
        if (piece == 1) return 1000;
        if (piece == 2) return 1200;
        if (piece == 3) return 1200;
        if (piece == 4) return 1500;
        if (piece == 5) return 2000;
        if (piece == 6) return 1500;
        if (piece == 7) return 600;
        return 0;
    }

    function piecePoints(uint8 piece) internal pure returns (uint32) {
        if (piece == 2 || piece == 3) return 30;
        if (piece == 4 || piece == 6) return 50;
        if (piece == 5) return 100;
        if (piece == 7) return 10;
        return 0;
    }

    function moveFeeBySteps(uint8 piece, uint8 steps) internal pure returns (uint256) {
        uint256 dist = steps == 0 ? 1 : uint256(steps);
        uint256 raw = BASE_FEE + dist * DIST_UNIT;
        return (raw * pieceMultBps(piece)) / 1000;
    }

    /// @dev 兼容旧签名：y 忽略，用 |x1-x0| 近似；新盘请用 moveFeeBySteps
    function moveFee(uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1) internal pure returns (uint256) {
        y0;
        y1;
        uint256 dist = x0 > x1 ? x0 - x1 : x1 - x0;
        if (dist == 0) dist = 1;
        return moveFeeBySteps(piece, uint8(dist));
    }

    function capturePenalty(uint8 piece) internal pure returns (uint256) {
        return uint256(piecePoints(piece)) * 0.001 ether;
    }
}
