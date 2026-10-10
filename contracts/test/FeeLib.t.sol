// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeLib} from "../src/libraries/FeeLib.sol";

contract FeeLibHarness {
    function moveFee(uint8 piece, uint8 x0, uint8 y0, uint8 x1, uint8 y1) external pure returns (uint256) {
        return FeeLib.moveFee(piece, x0, y0, x1, y1);
    }
}

contract FeeLibTest is Test {
    FeeLibHarness h;

    function setUp() public {
        h = new FeeLibHarness();
    }

    function test_SoldierOneStep() public view {
        // 卒走1格 = 0.009 MON
        assertEq(h.moveFee(7, 0, 0, 1, 0), 0.009 ether);
    }

    function test_ChariotFive() public view {
        // 车走5格 = 0.070 MON
        assertEq(h.moveFee(5, 0, 0, 5, 0), 0.07 ether);
    }

    function test_HorseDist2() public view {
        // 马 distance=2 = 0.030 MON
        assertEq(h.moveFee(4, 0, 0, 2, 1), 0.03 ether);
    }
}
