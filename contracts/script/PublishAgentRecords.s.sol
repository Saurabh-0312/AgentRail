// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {IRailResolver} from "./Sepolia.sol";

/// Declares the agent's per-chain keys on its ENS name, so "which key is the agent?" is answered by
/// the name, not discovered by reading three chains:
///
///   rail.agent.solana          base58 pubkey       (written in Phase 1)
///   rail.agent.hedera          EVM address of the Hedera account that pays and asks the mandate
///   rail.agent.hedera.account  the Hedera account id behind it
///   rail.agent.base            EVM address used on Base Sepolia
///   rail.allowed               JSON allow-list of payees per chain (only when RAIL_ALLOWED is set)
///
/// forge script script/PublishAgentRecords.s.sol --rpc-url sepolia --broadcast
contract PublishAgentRecords is Script {
    function run() external {
        uint256 ownerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        IRailResolver resolver = IRailResolver(vm.envAddress("RESOLVER_ADDRESS"));
        bytes32 node = vm.envBytes32("RAIL_NODE");
        string memory hederaEvm = vm.envString("HEDERA_EVM_ADDRESS");
        string memory hederaAccount = vm.envString("HEDERA_ACCOUNT_ID");
        string memory baseEvm = vm.envString("AGENT_EVM_ADDRESS");

        vm.startBroadcast(ownerPk);
        resolver.setText(node, "rail.agent.hedera", hederaEvm);
        resolver.setText(node, "rail.agent.hedera.account", hederaAccount);
        resolver.setText(node, "rail.agent.base", baseEvm);
        string memory allowed = vm.envOr("RAIL_ALLOWED", string(""));
        if (bytes(allowed).length != 0) {
            resolver.setText(node, "rail.allowed", allowed);
        }
        vm.stopBroadcast();

        console2.log("rail.agent.solana        ", resolver.text(node, "rail.agent.solana"));
        console2.log("rail.agent.hedera        ", resolver.text(node, "rail.agent.hedera"));
        console2.log("rail.agent.hedera.account", resolver.text(node, "rail.agent.hedera.account"));
        console2.log("rail.agent.base          ", resolver.text(node, "rail.agent.base"));
        console2.log("rail.allowed             ", resolver.text(node, "rail.allowed"));
    }
}
