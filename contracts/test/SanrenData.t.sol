// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {SanrenData} from "../src/libraries/SanrenData.sol";

/// @dev 直接暴露 SanrenData 的谓词，用于和 packages/shared 的地图数据对齐
contract Probe {
    function isAdj(uint8 a, uint8 b) external pure returns (bool) {
        return SanrenData.isAdj(a, b);
    }
    function lineStep(uint8 a, uint8 b) external pure returns (uint8) {
        return SanrenData.lineStep(a, b);
    }
    function sharedLine(uint8 a, uint8 b) external pure returns (bool, uint8, uint8, uint8) {
        return SanrenData.sharedLine(a, b);
    }
    function inPalace(uint8 c, uint8 n) external pure returns (bool) {
        return SanrenData.inPalace(c, n);
    }
    function inCamp(uint8 c, uint8 n) external pure returns (bool) {
        return SanrenData.inCamp(c, n);
    }
    function nodeCampOf(uint8 n) external pure returns (uint8) {
        return SanrenData.nodeCampOf(n);
    }
    function localF(uint8 c, uint8 n) external pure returns (int16) {
        return SanrenData.localF(c, n);
    }
    function localR(uint8 c, uint8 n) external pure returns (int16) {
        return SanrenData.localR(c, n);
    }
}

contract SanrenDataTest is Test {
    Probe p;
    function setUp() public {
        p = new Probe();
    }

    function test_SelfCheck() public view {
        // 自反：不相邻、线距 0
        assertFalse(p.isAdj(5, 5));
        assertEq(p.lineStep(5, 5), 0);
    }

    function test_AdjacencyIsSymmetric() public view {
        uint256 bad = 0;
        for (uint16 a = 0; a < SanrenData.NODE_COUNT; a++) {
            for (uint16 b = 0; b < SanrenData.NODE_COUNT; b++) {
                if (p.isAdj(uint8(a), uint8(b)) != p.isAdj(uint8(b), uint8(a))) bad++;
            }
        }
        assertEq(bad, 0, "adjacency must be symmetric");
    }

    function test_AdjacentImpliesLineStepOne() public view {
        uint256 bad = 0;
        for (uint16 a = 0; a < SanrenData.NODE_COUNT; a++) {
            for (uint16 b = 0; b < SanrenData.NODE_COUNT; b++) {
                if (p.isAdj(uint8(a), uint8(b)) && p.lineStep(uint8(a), uint8(b)) != 1) bad++;
            }
        }
        assertEq(bad, 0, "adjacent pair must have lineStep 1");
    }

    /// @dev 邻接必须由「同线且位次相邻」导出：两者互为充要。
    function test_AdjacencyMatchesLineAdjacency() public view {
        uint256 bad = 0;
        for (uint16 a = 0; a < SanrenData.NODE_COUNT; a++) {
            for (uint16 b = 0; b < SanrenData.NODE_COUNT; b++) {
                bool adj = p.isAdj(uint8(a), uint8(b));
                bool lineAdj = p.lineStep(uint8(a), uint8(b)) == 1;
                if (adj != lineAdj) bad++;
            }
        }
        assertEq(bad, 0, "isAdj must equal (lineStep == 1)");
    }

    /// @dev nodeCampOf 的取值必须在 0..3 之内（3 = 中宫/无营）。
    function test_NodeCampRange() public view {
        uint256 bad = 0;
        for (uint16 n = 0; n < SanrenData.NODE_COUNT; n++) {
            if (p.nodeCampOf(uint8(n)) > 3) bad++;
        }
        assertEq(bad, 0, "nodeCampOf out of range");
    }

    /// @dev 位图边界：九宫与本营查询在非法输入下必须返回 false，不能 revert。
    function test_BitmapsRejectOutOfRange() public view {
        assertFalse(p.inPalace(3, 0));
        assertFalse(p.inCamp(3, 0));
        assertFalse(p.inPalace(0, 250));
        assertFalse(p.inCamp(0, 250));
        assertFalse(p.isAdj(200, 0));
        assertEq(p.lineStep(200, 0), 0);
    }

    /// @dev 每个营地都必须有自己的九宫与本营成员（防止位图整层写错）。
    function test_EachCampHasMembers() public view {
        for (uint8 c = 0; c < 3; c++) {
            uint256 palaceCount = 0;
            uint256 campCount = 0;
            for (uint16 n = 0; n < SanrenData.NODE_COUNT; n++) {
                if (p.inPalace(c, uint8(n))) palaceCount++;
                if (p.inCamp(c, uint8(n))) campCount++;
            }
            assertGt(palaceCount, 0, "camp must have a palace");
            assertGt(campCount, 0, "camp must have nodes");
        }
    }
}
