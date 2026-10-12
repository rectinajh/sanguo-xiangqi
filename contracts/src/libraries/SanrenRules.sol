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

    /// @notice 该座位是否正被将军（帅所在节点被任一敌方棋子合法攻击）。
    ///
    /// @dev 只扫"可能攻击到帅"的敌方棋子，而不是全盘 139 个节点：
    ///      - 帅在九宫内，所以先定位帅的节点
    ///      - 遍历敌方所有棋子，对每个候选调用 isLegal（它已含炮架/马腿/九宫等全部规则）
    ///      这样把 O(139²) 降到 O(棋子数×1)，是可上链的成本。
    function isInCheck(uint8[160] storage board, uint8 seat) internal view returns (bool) {
        uint8 kingNode = _findGeneral(board, seat);
        if (kingNode == 255) return false; // 帅已被吃，游戏早该结束
        for (uint8 n = 0; n < SanrenData.NODE_COUNT; n++) {
            (uint8 p, uint8 s) = _unpack(board[n]);
            if (p == 0 || s == seat) continue;
            // 用 isLegal 判"这枚敌方棋子能否吃到帅所在的节点"
            if (isLegal(board, s, p, n, kingNode)) return true;
        }
        return false;
    }

    /// @notice 该座位是否还有任何合法着法（用于将死/困毙判定）。
    ///
    /// @dev 成本明显高于 isInCheck（要为每枚棋子枚举目标），所以**不放进热路径**：
    ///      只在需要判将死时（例如前端/agent 提示、或终局校验）调用。
    ///      这里只枚举"同线可达"与"相邻"的候选目标，覆盖全部合法着法类型。
    function hasAnyLegalMove(uint8[160] storage board, uint8 seat) internal view returns (bool) {
        for (uint8 from = 0; from < SanrenData.NODE_COUNT; from++) {
            (uint8 p, uint8 s) = _unpack(board[from]);
            if (p == 0 || s != seat) continue;
            // 候选目标：全部节点里能吃掉的目标 + 空点。为控制成本只试
            // 同线节点与相邻节点（SanrenData 的几何关系即合法着法的全部来源）。
            for (uint8 to = 0; to < SanrenData.NODE_COUNT; to++) {
                if (to == from) continue;
                if (isLegal(board, seat, p, from, to)) return true;
            }
        }
        return false;
    }

    /// @dev 找出某座位的帅所在节点；不在盘上返回 255。
    function _findGeneral(uint8[160] storage board, uint8 seat) private view returns (uint8) {
        for (uint8 n = 0; n < SanrenData.NODE_COUNT; n++) {
            (uint8 p, uint8 s) = _unpack(board[n]);
            if (p == 1 && s == seat) return n;
        }
        return 255;
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
