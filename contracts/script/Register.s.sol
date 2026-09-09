// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {Script, console2} from "forge-std/Script.sol";

import {AgentRailRegistry} from "../src/AgentRailRegistry.sol";
import {IETHRegistrar, IRailResolver, Sepolia} from "./Sepolia.sol";

/// Step 2 of the Sepolia rollout, after `Deploy.s.sol` and the 60s commitment age:
///  1. register `agentrail.eth` with AgentRailRegistry as its subregistry
///  2. issue the mandate subname `databot.agentrail.eth` to the agent's EVM address
///  3. write the rail.* records the agent will discover
///  4. let the agent write `rail.status`, and nothing else
///
/// forge script script/Register.s.sol --rpc-url sepolia --broadcast
contract Register is Script {
    string internal constant PARENT = "agentrail";
    string internal constant AGENT_LABEL = "databot";
    uint64 internal constant DURATION = 365 days;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        bytes32 secret = vm.envBytes32("ENS_COMMIT_SECRET");
        AgentRailRegistry registry = AgentRailRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        IRailResolver resolver = IRailResolver(vm.envAddress("RESOLVER_ADDRESS"));
        address agent = vm.envAddress("AGENT_EVM_ADDRESS");
        uint64 mandateExpiry = uint64(block.timestamp + vm.envOr("MANDATE_DAYS", uint256(30)) * 1 days);

        bytes32 node = _namehash(AGENT_LABEL, PARENT, "eth");
        bytes memory dnsName = abi.encodePacked(
            uint8(bytes(AGENT_LABEL).length), AGENT_LABEL, uint8(bytes(PARENT).length), PARENT, uint8(3), "eth", uint8(0)
        );

        vm.startBroadcast(pk);

        uint256 parentTokenId;
        if (IETHRegistrar(Sepolia.ETH_REGISTRAR).isAvailable(PARENT)) {
            parentTokenId = IETHRegistrar(Sepolia.ETH_REGISTRAR).register(
                PARENT, deployer, secret, IRegistry(address(registry)), address(resolver), DURATION, Sepolia.MOCK_USDC, bytes32(0)
            );
        }

        uint256 tokenId = registry.issueMandate(AGENT_LABEL, agent, address(resolver), mandateExpiry);

        resolver.setText(node, "rail.version", "1");
        resolver.setText(node, "rail.agent.solana", vm.envString("RAIL_AGENT_SOLANA"));
        resolver.setText(node, "rail.mandate.pda", vm.envString("RAIL_MANDATE_PDA"));
        resolver.setText(node, "rail.allowed", vm.envString("RAIL_ALLOWED"));
        resolver.authorizeTextRoles(dnsName, "rail.status", agent, true);

        vm.stopBroadcast();

        console2.log("agentrail.eth tokenId", parentTokenId);
        console2.log("databot.agentrail.eth tokenId", tokenId);
        console2.log("databot.agentrail.eth node");
        console2.logBytes32(node);
        console2.log("mandate expiry", mandateExpiry);
        console2.log("rail.agent.solana", resolver.text(node, "rail.agent.solana"));
    }

    function _namehash(string memory l3, string memory l2, string memory l1) internal pure returns (bytes32 n) {
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l1))));
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l2))));
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l3))));
    }
}
