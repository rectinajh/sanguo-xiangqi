// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-8004-style agent identity + reputation
contract AgentRegistry {
    struct Reputation {
        uint32 games;
        uint32 wins;
        uint32 slashed;
        uint32 betrayalIndex;
        int32 trustScore;
        uint256 forcedBurnMonTotal;
        bool registered;
        string metadataURI;
    }

    mapping(address => Reputation) public agents;
    address public gameTable;

    event AgentRegistered(address indexed agent, string metadataURI);
    event GameResultRecorded(
        address indexed agent,
        uint256 indexed gameId,
        bool won,
        bool wasSlashed,
        uint256 forcedBurnMon
    );

    modifier onlyGame() {
        require(msg.sender == gameTable, "only game");
        _;
    }

    function setGameTable(address g) external {
        require(gameTable == address(0) || msg.sender == gameTable, "set");
        gameTable = g;
    }

    function registerAgent(string calldata metadataURI) external {
        Reputation storage r = agents[msg.sender];
        require(!r.registered, "exists");
        r.registered = true;
        r.metadataURI = metadataURI;
        r.trustScore = 100;
        emit AgentRegistered(msg.sender, metadataURI);
    }

    function recordGameResult(
        address agent,
        uint256 gameId,
        bool won,
        bool wasSlashed,
        uint256 forcedBurnMon
    ) external onlyGame {
        Reputation storage r = agents[agent];
        if (!r.registered) {
            r.registered = true;
            r.trustScore = 100;
        }
        r.games += 1;
        if (won) {
            r.wins += 1;
            r.trustScore += 5;
        } else {
            r.trustScore -= 2;
        }
        if (wasSlashed) {
            r.slashed += 1;
            r.betrayalIndex += 10;
            r.trustScore -= 20;
        }
        r.forcedBurnMonTotal += forcedBurnMon;
        emit GameResultRecorded(agent, gameId, won, wasSlashed, forcedBurnMon);
    }

    function getReputation(address agent) external view returns (Reputation memory) {
        return agents[agent];
    }
}
