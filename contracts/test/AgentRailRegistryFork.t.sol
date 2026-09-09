// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IEnhancedAccessControl} from "@ens-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {PermissionedResolverLib} from "@ens-v2/resolver/libraries/PermissionedResolverLib.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LibLabel} from "@ens-v2/utils/LibLabel.sol";
import {Test} from "forge-std/Test.sol";

import {AgentRailRegistry} from "../src/AgentRailRegistry.sol";
import {AgentRailRegistryTest} from "./AgentRailRegistry.t.sol";

/// @dev The slice of ENSv2's PermissionedResolver these tests exercise, on its real Sepolia bytecode.
interface IRailResolver {
    function initialize(address admin, uint256 roleBitmap, bytes[] calldata setters) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
}

/// @dev ensdomains/contracts-v2 :: contracts/deployments/sepolia
library Sepolia {
    address internal constant LABEL_STORE = 0xB03524289C16424f71802A1794c29c7Bd1B9f577;
    address internal constant PERMISSIONED_RESOLVER_IMPL = 0x7E4B2d59938930168024201752EE5503df402303;
}

abstract contract SepoliaFork is Test {
    /// @dev Skips the whole contract when no RPC is configured, so CI without secrets stays green.
    function _fork() internal {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }
}

/// Every lifecycle test again, this time against the shared Sepolia LabelStore.
/// Run: forge test --match-contract Fork -vv   (needs SEPOLIA_RPC_URL)
contract AgentRailRegistryForkTest is AgentRailRegistryTest, SepoliaFork {
    function setUp() public override {
        _fork();
        registry = new AgentRailRegistry(ILabelStore(Sepolia.LABEL_STORE), alice);
        expiry = uint64(block.timestamp + 1 hours);
    }

    function test_fork_labelLandsInSharedLabelStore() public {
        _issue();
        assertEq(ILabelStore(Sepolia.LABEL_STORE).getLabel(LibLabel.id(LABEL)), LABEL, "label is invertible chain-wide");
    }
}

/// EAC on the real PermissionedResolver: the agent may write `rail.status` and nothing else.
contract ResolverEACForkTest is SepoliaFork {
    IRailResolver internal resolver;
    address internal alice = makeAddr("alice");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    // databot.alice.eth
    bytes internal constant DNS_NAME = hex"076461746162" hex"6f74" hex"05616c696365" hex"03657468" hex"00";
    bytes32 internal node;

    uint256 internal constant ALICE_ROLES =
        PermissionedResolverLib.ROLE_SET_TEXT | PermissionedResolverLib.ROLE_SET_TEXT_ADMIN;

    function setUp() public {
        _fork();
        node = _namehash("databot", "alice", "eth");

        // A fresh proxy over the deployed implementation, exactly as ENSv2 intends resolvers to be created.
        bytes memory init = abi.encodeCall(IRailResolver.initialize, (alice, ALICE_ROLES, new bytes[](0)));
        resolver = IRailResolver(address(new ERC1967Proxy(Sepolia.PERMISSIONED_RESOLVER_IMPL, init)));
    }

    function _namehash(string memory l3, string memory l2, string memory l1) internal pure returns (bytes32 n) {
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l1))));
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l2))));
        n = keccak256(abi.encodePacked(n, keccak256(bytes(l3))));
    }

    function _unauthorized(address who) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
            PermissionedResolverLib.resource(node, bytes32(0)),
            PermissionedResolverLib.ROLE_SET_TEXT,
            who
        );
    }

    function _grantStatus() internal {
        vm.prank(alice);
        resolver.authorizeTextRoles(DNS_NAME, "rail.status", agent, true);
    }

    function test_owner_writesMandateRecords_readableSynchronously() public {
        vm.startPrank(alice);
        resolver.setText(node, "rail.version", "1");
        resolver.setText(node, "rail.agent.solana", "AgentPubkeyBase58");
        resolver.setText(node, "rail.allowed", "[{\"chain\":\"solana\",\"target\":\"shop\",\"perTx\":\"5000000\"}]");
        resolver.setText(node, "rail.mandate.pda", "MandatePdaBase58");
        vm.stopPrank();

        assertEq(resolver.text(node, "rail.version"), "1");
        assertEq(resolver.text(node, "rail.agent.solana"), "AgentPubkeyBase58");
        assertEq(resolver.text(node, "rail.mandate.pda"), "MandatePdaBase58");
        assertEq(resolver.text(node, "rail.status"), "", "unset reads as empty, no revert");
    }

    function test_agent_canWriteStatusOnceAuthorized() public {
        _grantStatus();
        uint256 part = PermissionedResolverLib.resource(node, PermissionedResolverLib.partHash("rail.status"));
        assertTrue(resolver.hasRoles(part, PermissionedResolverLib.ROLE_SET_TEXT, agent), "scoped to one key");

        vm.prank(agent);
        resolver.setText(node, "rail.status", "active");
        assertEq(resolver.text(node, "rail.status"), "active");

        vm.prank(agent);
        resolver.setText(node, "rail.status", "paused");
        assertEq(resolver.text(node, "rail.status"), "paused");
    }

    function test_agent_cannotWriteItsOwnPermissions() public {
        _grantStatus();
        vm.prank(agent);
        vm.expectRevert(_unauthorized(agent));
        resolver.setText(node, "rail.allowed", "[]");
    }

    function test_agent_cannotWriteAnyOtherRecord() public {
        _grantStatus();
        vm.startPrank(agent);
        vm.expectRevert(_unauthorized(agent));
        resolver.setText(node, "rail.agent.solana", "attacker");
        vm.expectRevert(_unauthorized(agent));
        resolver.setText(node, "rail.mandate.pda", "attacker");
        vm.stopPrank();
    }

    function test_agent_cannotWidenItsOwnAuthority() public {
        _grantStatus();
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEnhancedAccessControl.EACCannotGrantRoles.selector,
                PermissionedResolverLib.resource(node, bytes32(0)),
                PermissionedResolverLib.ROLE_SET_TEXT,
                agent
            )
        );
        resolver.authorizeTextRoles(DNS_NAME, "rail.allowed", agent, true);
    }

    function test_agent_cannotWriteBeforeAuthorization() public {
        vm.prank(agent);
        vm.expectRevert(_unauthorized(agent));
        resolver.setText(node, "rail.status", "active");
    }

    function test_stranger_cannotWriteStatus() public {
        _grantStatus();
        vm.prank(stranger);
        vm.expectRevert(_unauthorized(stranger));
        resolver.setText(node, "rail.status", "active");
    }

    function test_owner_canRevokeStatusRole() public {
        _grantStatus();
        vm.prank(alice);
        resolver.authorizeTextRoles(DNS_NAME, "rail.status", agent, false);
        vm.prank(agent);
        vm.expectRevert(_unauthorized(agent));
        resolver.setText(node, "rail.status", "active");
    }
}
