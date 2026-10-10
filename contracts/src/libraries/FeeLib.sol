// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Mirrors packages/shared/fees.ts — FINAL PRD §4.2 / §4.3
library FeeLib {
    uint256 internal constant BASE_FEE = 0.01 ether; // 0.010 MON
    uint256 internal constant DIST_UNIT = 0.005 ether;

    // pieceMult ×1000
    function pieceMultBps(uint8 piece) internal pure returns (uint256) {
        if (piece == 1) return 1000; // General
        if (piece == 2) return 1200; // Advisor
        if (piece == 3) return 1200; // Elephant
        if (piece == 4) return 1500; // Horse
        if (piece == 5) return 2000; // Chariot
        if (piece == 6) return 1500; // Cannon
        if (piece == 7) return 600; // Soldier
        return 0;
    }

    function piecePoints(uint8 piece) internal pure returns (uint32) {
        if (piece == 2 || piece == 3) return 30;
        if (piece == 4 || piece == 6) return 50;
        if (piece == 5) return 100;
        if (piece == 7) return 10;
        return 0;
    }

    function chebyshev(uint8 x0, uint8 y0, uint8 x1, uint8 y1) internal pure returns (uint256) {
        uint256 dx = x0 > x1 ? x0 - x1 : x1 - x0;
        uint256 dy = y0 > y1 ? y0 - y1 : y1 - y0;
        return dx > dy ? dx : dy;
    }

    function moveFee(uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1) internal pure returns (uint256) {
        uint256 dist = chebyshev(x0, y0, x1, y1);
        uint256 raw = BASE_FEE + dist * DIST_UNIT;
        return (raw * pieceMultBps(piece)) / 1000;
    }

    function capturePenalty(uint8 piece) internal pure returns (uint256) {
        // points * 0.001 ether
        return uint256(piecePoints(piece)) * 0.001 ether;
    }
}
