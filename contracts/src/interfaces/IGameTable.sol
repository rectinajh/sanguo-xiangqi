// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Slice of GameTable used by Covenant. Phase is ABI-encoded as uint8.
interface IGameTable {
    function getSeat(uint256 gameId, uint8 seat)
        external
        view
        returns (address player, uint256 seatStake, uint256 playBalance, uint32 points, bool eliminated);

    function getGameMeta(uint256 gameId)
        external
        view
        returns (uint8 phase, uint8 turn, uint32 ply, bool aiRevealed, uint8 winnerSeat, uint256 prizePool);

    function advisorBetrayal(uint256 gameId, uint8 attacker, uint8 victim, uint32 activatedPly)
        external
        view
        returns (bool);

    function peaceBetrayal(uint256 gameId, uint8 attacker, uint8 victim, uint32 activatedPly, uint32 untilPly)
        external
        view
        returns (bool);

    /// @dev Credits slash bond into the victim's playBalance. Caller must be the bound Covenant.
    function creditSlash(uint256 gameId, uint8 victimSeat, uint8 betrayerSeat) external payable;
}
