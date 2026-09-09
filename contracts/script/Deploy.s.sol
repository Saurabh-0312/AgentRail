// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {Script, console2} from "forge-std/Script.sol";

import {AgentRailRegistry} from "../src/AgentRailRegistry.sol";
import {IETHRegistrar, IMockUSDC, IRailResolver, Sepolia} from "./Sepolia.sol";

/// Step 1 of the Sepolia rollout. Deploys the registry and a resolver proxy, funds the .eth
/// registration, and commits to `agentrail.eth`. `Register.s.sol` follows after MIN_COMMITMENT_AGE.
///
/// forge script script/Deploy.s.sol --rpc-url sepolia --broadcast
contract Deploy is Script {
    string internal constant LABEL = "agentrail";
    uint64 internal constant DURATION = 365 days;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        bytes32 secret = vm.envBytes32("ENS_COMMIT_SECRET");
        IETHRegistrar registrar = IETHRegistrar(Sepolia.ETH_REGISTRAR);
        require(registrar.isAvailable(LABEL), "agentrail.eth is taken");

        vm.startBroadcast(pk);

        AgentRailRegistry registry = new AgentRailRegistry(ILabelStore(Sepolia.LABEL_STORE), deployer);

        bytes memory init =
            abi.encodeCall(IRailResolver.initialize, (deployer, Sepolia.RESOLVER_OWNER_ROLES, new bytes[](0)));
        address resolver = address(new ERC1967Proxy(Sepolia.PERMISSIONED_RESOLVER_IMPL, init));

        IMockUSDC usdc = IMockUSDC(Sepolia.MOCK_USDC);
        if (usdc.balanceOf(deployer) < 10e6) {
            usdc.mint(deployer, 10e6);
        }
        usdc.approve(Sepolia.ETH_REGISTRAR, type(uint256).max);

        bytes32 commitment =
            registrar.makeCommitment(LABEL, deployer, secret, address(registry), resolver, DURATION, bytes32(0));
        registrar.commit(commitment);

        vm.stopBroadcast();

        console2.log("REGISTRY_ADDRESS", address(registry));
        console2.log("RESOLVER_ADDRESS", resolver);
        console2.log("commitment placed; run Register.s.sol after 60s");
    }
}
