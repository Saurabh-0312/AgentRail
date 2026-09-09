// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {IRailResolver} from "./Sepolia.sol";

/// @dev ERC-8004 Identity Registry (ERC-721 + URIStorage). Same address on every testnet.
interface IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 tokenId) external view returns (address);
    function tokenURI(uint256 tokenId) external view returns (string memory);
}

/// ERC-8004 identity for databot.agentrail.eth, then the `rail.erc8004` record that binds it.
///
///  1. the AGENT registers itself: it owns its identity NFT, nobody else does
///  2. the registry owner writes `rail.erc8004 = eip155:11155111:<registry>:<agentId>` on the resolver
///
/// The agent URI is a base64 `data:` URI (fully on-chain registration file), built by the caller
/// and passed as ERC8004_AGENT_URI.
///
/// forge script script/RegisterAgentIdentity.s.sol --rpc-url sepolia --broadcast
contract RegisterAgentIdentity is Script {
    address internal constant IDENTITY_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function run() external {
        uint256 agentPk = vm.envUint("AGENT_EVM_PRIVATE_KEY");
        uint256 ownerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory agentURI = vm.envString("ERC8004_AGENT_URI");
        IRailResolver resolver = IRailResolver(vm.envAddress("RESOLVER_ADDRESS"));
        bytes32 node = vm.envBytes32("RAIL_NODE");
        IIdentityRegistry registry = IIdentityRegistry(IDENTITY_REGISTRY);

        vm.startBroadcast(agentPk);
        uint256 agentId = registry.register(agentURI);
        vm.stopBroadcast();
        require(registry.ownerOf(agentId) == vm.addr(agentPk), "agent does not own its identity");

        string memory record = string.concat(
            "eip155:", vm.toString(block.chainid), ":", vm.toString(IDENTITY_REGISTRY), ":", vm.toString(agentId)
        );
        vm.startBroadcast(ownerPk);
        resolver.setText(node, "rail.erc8004", record);
        vm.stopBroadcast();

        console2.log("ERC8004_AGENT_ID", agentId);
        console2.log("rail.erc8004", resolver.text(node, "rail.erc8004"));
    }
}
