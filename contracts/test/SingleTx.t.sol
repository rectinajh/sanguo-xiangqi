// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameTable} from "../src/GameTable.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @dev 一步一签：commitAndRevealMove。
///
/// 背景：原来每走一步要发两笔交易（commitMove + revealMove），用户签两次。
/// 而 revealMove 要求 `g.turn == seat`，也就是必须轮到你才能交 —— 在顺序走子下
/// commit-reveal 并没有隐藏任何东西，那两次签名是纯摩擦。这里钉住合并后的行为。
contract SingleTxTest is Test {
    GameTable game;
    AgentRegistry reg;
    uint256 keyA = 0xA11;
    uint256 keyB = 0xB22;
    uint256 keyC = 0xC33;
    address payable a;
    address payable b;
    address payable c;

    uint256 constant JOIN_VALUE = 0.05 ether + 0.3 ether;

    function setUp() public {
        a = payable(vm.addr(keyA));
        b = payable(vm.addr(keyB));
        c = payable(vm.addr(keyC));
        reg = new AgentRegistry();
        game = new GameTable(address(reg));
        reg.setGameTable(address(game));
        vm.deal(a, 100 ether);
        vm.deal(b, 100 ether);
        vm.deal(c, 100 ether);
    }

    function _start() internal returns (uint256 id) {
        id = game.createGame(2);
        vm.prank(a);
        game.join{value: JOIN_VALUE}(id, 0);
        vm.prank(b);
        game.join{value: JOIN_VALUE}(id, 1);
        vm.prank(c);
        game.join{value: JOIN_VALUE}(id, 2);
    }

    function _hash(uint8 seat, uint8 fx, uint8 tx, uint8 piece, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(seat, fx, uint8(0), tx, uint8(0), piece, salt));
    }

    /// 一笔交易走完一步，且扣费与两笔版本一致。
    function test_SingleTxMoveSucceeds() public {
        uint256 id = _start();
        bytes32 salt = keccak256("s1");
        uint8 piece = 7; // soldier
        bytes32 ch = _hash(0, 72, 78, piece, salt);

        (,, uint256 playBefore,,) = game.getSeat(id, 0);
        vm.prank(a);
        game.commitAndRevealMove(id, 72, 0, 79, 0, piece, salt, ch);

        (,, uint256 playAfter,,) = game.getSeat(id, 0);
        assertLt(playAfter, playBefore, "move fee charged");

        // 回合已推进，且该座没有残留 commit
        (,, uint32 ply,,,) = game.getGameMeta(id);
        assertEq(ply, 1, "ply advanced");
    }

    /// 承诺与明文不符必须被拒 —— 否则等于允许伪造别人的走法。
    function test_CommitMismatchRejected() public {
        uint256 id = _start();
        bytes32 salt = keccak256("s2");
        bytes32 wrong = _hash(0, 72, 79, 7, salt); // 明文是 72->78，承诺写成 72->79

        vm.prank(a);
        vm.expectRevert(bytes("commit mismatch"));
        game.commitAndRevealMove(id, 72, 0, 79, 0, 7, salt, wrong);
    }

    /// 不是你的回合不能走（沿用 revealMove 的 turn 校验）。
    function test_NotYourTurnRejected() public {
        uint256 id = _start();
        bytes32 salt = keccak256("s3");
        bytes32 ch = _hash(1, 31, 38, 7, salt); // b 的座是 1，但当前 turn 是 0

        vm.prank(b);
        vm.expectRevert(bytes("turn"));
        game.commitAndRevealMove(id, 29, 0, 36, 0, 7, salt, ch);
    }

    /// 走完一步之后不能再用同一个承诺重放（commit 已被 reveal 清掉，且回合已换人）。
    function test_CannotReplaySameMove() public {
        uint256 id = _start();
        bytes32 salt = keccak256("s4");
        bytes32 ch = _hash(0, 72, 78, 7, salt);

        vm.prank(a);
        game.commitAndRevealMove(id, 72, 0, 79, 0, 7, salt, ch);

        vm.prank(a);
        vm.expectRevert(bytes("turn"));
        game.commitAndRevealMove(id, 72, 0, 79, 0, 7, salt, ch);
    }

    /// 非法走法（几何不成立）应被拒，且不扣费到无法解释的程度。
    function test_IllegalGeometryRejected() public {
        uint256 id = _start();
        bytes32 salt = keccak256("s5");
        // 卒 72 -> 0（不可能的一步）
        bytes32 ch = _hash(0, 72, 0, 7, salt);

        vm.prank(a);
        vm.expectRevert();
        game.commitAndRevealMove(id, 72, 0, 0, 0, 7, salt, ch);
    }
}
