// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {EvmMandate} from "../src/EvmMandate.sol";

/// One artifact, two chains. The same script deploys the EVM twin of the Solana gate to
/// Hedera testnet (where the x402 service settles) and Base Sepolia (where The Graph settles).
///
///   forge script script/DeployEvmMandate.s.sol --rpc-url hedera_testnet --broadcast
///   forge script script/DeployEvmMandate.s.sol --rpc-url base_sepolia   --broadcast
contract DeployEvmMandate is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        EvmMandate mandate = new EvmMandate();
        vm.stopBroadcast();
        console2.log("chain", block.chainid);
        console2.log("EVM_MANDATE_ADDRESS", address(mandate));
        console2.log("MAX_PERMISSIONS", mandate.MAX_PERMISSIONS());
    }
}
