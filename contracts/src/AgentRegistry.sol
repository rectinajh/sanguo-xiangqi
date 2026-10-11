// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 最小 ERC-8004 风格 agent 身份 + 声誉
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
    address public deployer;

    event AgentRegistered(address indexed agent, string metadataURI);
    event GameTableClaimed(address indexed gameTable);
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

    constructor() {
        deployer = msg.sender;
    }

    /// @notice 由部署者指定游戏合约；只有被指定的合约才能来认领。
    /// @dev 老版本是 `require(gameTable == address(0) || msg.sender == gameTable)`，
    ///      即 gameTable 为空时【任何人】都能抢占这个一次性初始化位。抢到之后
    ///      GameTable 的 finalizeGame 会永久 revert（且当时 GameTable 没有
    ///      setRegistry），所有质押都会被锁死。这里改成部署者 + 对端认领的握手。
    function setGameTable(address g) external {
        require(msg.sender == deployer, "only deployer");
        require(g != address(0), "zero");
        require(g.code.length > 0, "not contract");
        require(gameTable == address(0), "already set");
        gameTable = g;
    }

    /// @notice 由被指定的游戏合约自己认领，避免部署者写错地址后无法补救。
    function claimGameTable() external {
        require(msg.sender == gameTable, "not designated");
        emit GameTableClaimed(msg.sender);
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
        // 不再对未注册地址做"自动注册"：老版本会让 address(0) 这类地址在
        // 第一次战果写入时就变成 registered=true、trustScore=100，声誉因此可被污染。
        Reputation storage r = agents[agent];
        require(r.registered, "not registered");
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
