// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SanrenData} from "./SanrenData.sol";
import {FeeLib} from "./FeeLib.sol";

/// @notice Graph legality + step fees for the photo-traced sanren board.
library SanrenRules {
    function moveSteps(uint8 piece, uint8 fromNode, uint8 toNode) internal pure returns (uint8) {
        if (piece == 4 || piece == 3) return 2; // horse / elephant
        if (piece == 2) return 1; // advisor
        uint8 ls = SanrenData.lineStep(fromNode, toNode);
        if (ls > 0) return ls;
        return 1;
    }

    function fee(uint8 piece, uint8 fromNode, uint8 toNode) internal pure returns (uint256) {
        return FeeLib.moveFeeBySteps(piece, moveSteps(piece, fromNode, toNode));
    }

    function findNode(uint8 camp, int16 f, int16 r) internal pure returns (uint8) {
        for (uint8 n = 0; n < SanrenData.NODE_COUNT; n++) {
            if (SanrenData.localF(camp, n) == f && SanrenData.localR(camp, n) == r) return n;
        }
        revert("no node");
    }

    function isLegal(uint8[160] storage board, uint8 seat, uint8 piece, uint8 fromNode, uint8 toNode)
        public
        view
        returns (bool)
    {
        if (fromNode >= SanrenData.NODE_COUNT || toNode >= SanrenData.NODE_COUNT) return false;
        if (fromNode == toNode) return false;
        (uint8 bp, uint8 bs) = _unpack(board[fromNode]);
        if (bp != piece || bs != seat) return false;
        (uint8 dp, uint8 ds) = _unpack(board[toNode]);
        if (ds == seat) return false;

        if (piece == 1) {
            // General
            if (!SanrenData.inPalace(seat, fromNode) || !SanrenData.inPalace(seat, toNode)) return false;
            return SanrenData.isAdj(fromNode, toNode);
        }
        if (piece == 2) {
            // Advisor
            if (!SanrenData.inPalace(seat, fromNode) || !SanrenData.inPalace(seat, toNode)) return false;
            if (!SanrenData.isAdj(fromNode, toNode)) return false;
            int16 f0 = SanrenData.localF(seat, fromNode);
            int16 r0 = SanrenData.localR(seat, fromNode);
            int16 f1 = SanrenData.localF(seat, toNode);
            int16 r1 = SanrenData.localR(seat, toNode);
            return _abs16(f0 - f1) == 1 && _abs16(r0 - r1) == 1;
        }
        if (piece == 3) {
            // Elephant
            if (!SanrenData.inCamp(seat, fromNode) || !SanrenData.inCamp(seat, toNode)) return false;
            int16 f0 = SanrenData.localF(seat, fromNode);
            int16 r0 = SanrenData.localR(seat, fromNode);
            int16 f1 = SanrenData.localF(seat, toNode);
            int16 r1 = SanrenData.localR(seat, toNode);
            if (_abs16(f0 - f1) != 2 || _abs16(r0 - r1) != 2) return false;
            uint8 eye = findNode(seat, (f0 + f1) / 2, (r0 + r1) / 2);
            return board[eye] == 0;
        }
        if (piece == 4) {
            return SanrenData.horseOk(fromNode, toNode, board);
        }
        if (piece == 5 || piece == 6) {
            uint8 steps = SanrenData.lineStep(fromNode, toNode);
            if (steps == 0) return false;
            int8 between = SanrenData.countBetween(fromNode, toNode, board);
            if (between < 0) return false;
            if (piece == 5) return between == 0;
            if (dp == 0) return between == 0;
            return between == 1;
        }
        if (piece == 7) {
            return _soldierOk(board, seat, fromNode, toNode);
        }
        return false;
    }

    function _soldierOk(uint8[160] storage board, uint8 seat, uint8 fromNode, uint8 toNode)
        internal
        view
        returns (bool)
    {
        board; // silence — adjacency only uses geometry
        if (!SanrenData.isAdj(fromNode, toNode)) return false;
        uint8 fromCamp = SanrenData.nodeCampOf(fromNode);
        if (fromCamp == seat) {
            int16 f0 = SanrenData.localF(seat, fromNode);
            int16 r0 = SanrenData.localR(seat, fromNode);
            int16 f1 = SanrenData.localF(seat, toNode);
            int16 r1 = SanrenData.localR(seat, toNode);
            if (f0 >= 0 && f1 >= 0 && f0 == f1 && r1 == r0 + 1) return true;
            if (f0 == 4 && r0 == 4 && toNode == SanrenData.gateOf(seat)) return true;
            return false;
        }
        // After leaving own camp: any adjacent step (slightly looser than TS citadel BFS)
        return true;
    }

    function _abs16(int16 v) private pure returns (int16) {
        return v < 0 ? -v : v;
    }

    function _unpack(uint8 packed) private pure returns (uint8 piece, uint8 seat) {
        if (packed == 0) return (0, 255);
        piece = packed & 0x0f;
        seat = (packed >> 4) - 1;
    }
}
