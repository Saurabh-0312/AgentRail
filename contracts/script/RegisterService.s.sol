// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {LibLabel} from "@ens-v2/utils/LibLabel.sol";
import {Script, console2} from "forge-std/Script.sol";

import {AgentRailRegistry} from "../src/AgentRailRegistry.sol";
import {IRailResolver} from "./Sepolia.sol";

/// Services get names too. A service subname under agentrail.eth carries the five discovery
/// records (SPEC §8.3.4) an agent needs to find and pay for it without a URL or an API key:
///
///   rail.endpoint   the paid resource base URL
///   rail.chain      selects the payment adapter (hedera:testnet | eip155:84532 | solana:devnet)
///   rail.price      base units per unit of service
///   rail.token      asset id on that chain (HTS token id, ERC-20 address, SPL mint)
///   rail.scheme     x402
///
/// The mandate name says who the agent is; the service name says what exists to buy.
///
/// SERVICE_LABEL=feed RAIL_ENDPOINT=... RAIL_CHAIN=... RAIL_PRICE=... RAIL_TOKEN=... \
///   forge script script/RegisterService.s.sol --rpc-url sepolia --broadcast
contract RegisterService is Script {
    string internal constant PARENT = "agentrail";
    uint64 internal constant DURATION = 365 days;

    string[6] internal KEYS = ["rail.endpoint", "rail.chain", "rail.price", "rail.token", "rail.scheme", "description"];
    string[6] internal ENVS = ["RAIL_ENDPOINT", "RAIL_CHAIN", "RAIL_PRICE", "RAIL_TOKEN", "RAIL_SCHEME", "RAIL_DESCRIPTION"];

    function run() external {
        string memory label = vm.envString("SERVICE_LABEL");
        bytes32 node = _namehash(label, PARENT, "eth");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        _register(label);
        _writeRecords(node);
        vm.stopBroadcast();

        _report(label, node);
    }

    /// @dev Owned by the registry owner; no token roles needed, root roles govern it.
    function _register(string memory label) internal {
        AgentRailRegistry registry = AgentRailRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        if (registry.getOwner(LibLabel.id(label)) != address(0)) return;
        registry.register(
            label,
            vm.addr(vm.envUint("DEPLOYER_PRIVATE_KEY")),
            IRegistry(address(0)),
            vm.envAddress("RESOLVER_ADDRESS"),
            0,
            uint64(block.timestamp) + DURATION
        );
    }

    function _writeRecords(bytes32 node) internal {
        IRailResolver resolver = IRailResolver(vm.envAddress("RESOLVER_ADDRESS"));
        for (uint256 i; i < KEYS.length; ++i) {
            string memory value = vm.envOr(ENVS[i], string(""));
            if (bytes(value).length == 0) {
                if (i == 4) value = "x402"; // rail.scheme default
                else continue;
            }
            resolver.setText(node, KEYS[i], value);
        }
    }

    function _report(string memory label, bytes32 node) internal view {
        AgentRailRegistry registry = AgentRailRegistry(vm.envAddress("REGISTRY_ADDRESS"));
        IRailResolver resolver = IRailResolver(vm.envAddress("RESOLVER_ADDRESS"));
        console2.log(string.concat(label, ".agentrail.eth"));
        console2.logBytes32(node);
        console2.log("  owner ", registry.getOwner(LibLabel.id(label)));
        console2.log("  expiry", registry.getExpiry(LibLabel.id(label)));
        for (uint256 i; i < KEYS.length; ++i) {
            console2.log(string.concat("  ", KEYS[i], " = ", resolver.text(node, KEYS[i])));
        }
    }

    function _namehash(string memory l3, string memory l2, string memory l1) internal pure returns (bytes32 n) {
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l1))));
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l2))));
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l3))));
    }
}
