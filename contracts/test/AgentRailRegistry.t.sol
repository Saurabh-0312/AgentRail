// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IEnhancedAccessControl} from "@ens-v2/access-control/interfaces/IEnhancedAccessControl.sol";
import {IPermissionedRegistry} from "@ens-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {IStandardRegistry} from "@ens-v2/registry/interfaces/IStandardRegistry.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LibLabel} from "@ens-v2/utils/LibLabel.sol";

import {AgentRailRegistry} from "../src/AgentRailRegistry.sol";

/// @dev Stands in for the shared ENSv2 LabelStore off-fork. The fork suite uses the real one.
contract MockLabelStore is ILabelStore {
    mapping(uint256 => string) internal _labels;

    function setLabel(string calldata label) external {
        uint256 id = LibLabel.id(label);
        if (bytes(_labels[id]).length == 0) {
            _labels[id] = label;
            emit Label(bytes32(id), label);
        }
    }

    function getLabel(uint256 anyId) external view returns (string memory) {
        return _labels[LibLabel.withVersion(anyId, 0)];
    }
}

/// Subname lifecycle: expiring, revocable, non-transferable, and the agent can widen nothing.
contract AgentRailRegistryTest is Test {
    AgentRailRegistry internal registry;
    address internal alice = makeAddr("alice");
    address internal agent = makeAddr("agent");
    address internal buyer = makeAddr("buyer");
    address internal resolver = makeAddr("resolver");
    string internal constant LABEL = "databot";
    uint64 internal expiry;

    function setUp() public virtual {
        registry = new AgentRailRegistry(new MockLabelStore(), alice);
        expiry = uint64(block.timestamp + 1 hours);
    }

    function _labelId() internal pure returns (uint256) {
        return LibLabel.id(LABEL);
    }

    function _issue() internal returns (uint256 tokenId) {
        vm.prank(alice);
        tokenId = registry.issueMandate(LABEL, agent, resolver, expiry);
    }

    /// @dev Expected revert for `who` lacking `role` on the token's resource. Computed before any
    ///      prank: the view call would otherwise consume it.
    function _missingRole(uint256 tokenId, uint256 role, address who) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector, registry.getResource(tokenId), role, who
        );
    }

    // ---- issue -------------------------------------------------------------------------------

    function test_issue_mintsToAgentWithExpiryAndResolver() public {
        uint256 tokenId = _issue();
        assertEq(registry.ownerOf(tokenId), agent, "agent owns the subname");
        assertEq(registry.mandateAgent(LABEL), agent);
        assertEq(registry.getExpiry(_labelId()), expiry);
        assertEq(registry.getResolver(LABEL), resolver);
        assertTrue(registry.isMandateActive(LABEL));
        assertEq(uint8(registry.getStatus(_labelId())), uint8(IPermissionedRegistry.Status.REGISTERED));
    }

    function test_issue_agentHoldsNoRoles() public {
        uint256 tokenId = _issue();
        assertEq(registry.roles(tokenId, agent), 0, "zero token roles");
        assertFalse(registry.hasRoles(tokenId, RegistryRolesLib.ROLE_RENEW, agent));
        assertFalse(registry.hasRoles(tokenId, RegistryRolesLib.ROLE_UNREGISTER, agent));
        assertFalse(registry.hasRoles(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, agent));
        assertFalse(registry.hasRoles(tokenId, RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, agent));
    }

    function test_issue_rejectsNonOwner() public {
        bytes memory err = abi.encodeWithSelector(
            IEnhancedAccessControl.EACUnauthorizedAccountRoles.selector,
            registry.ROOT_RESOURCE(),
            RegistryRolesLib.ROLE_REGISTRAR,
            agent
        );
        vm.prank(agent);
        vm.expectRevert(err);
        registry.issueMandate(LABEL, agent, resolver, expiry);
    }

    function test_issue_rejectsPastExpiry() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IStandardRegistry.CannotSetPastExpiry.selector, uint64(block.timestamp))
        );
        registry.issueMandate(LABEL, agent, resolver, uint64(block.timestamp));
    }

    function test_issue_rejectsZeroAgent() public {
        vm.prank(alice);
        vm.expectRevert(AgentRailRegistry.ZeroAgent.selector);
        registry.issueMandate(LABEL, address(0), resolver, expiry);
    }

    function test_issue_rejectsLiveLabel() public {
        _issue();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.LabelAlreadyRegistered.selector, LABEL));
        registry.issueMandate(LABEL, buyer, resolver, expiry);
    }

    // ---- expiring ----------------------------------------------------------------------------

    function test_expiry_isEnforcedByENS() public {
        uint256 tokenId = _issue();
        vm.warp(expiry);
        assertEq(registry.ownerOf(tokenId), address(0), "no owner once expired");
        assertEq(registry.mandateAgent(LABEL), address(0));
        assertEq(registry.getResolver(LABEL), address(0), "resolver disappears too");
        assertFalse(registry.isMandateActive(LABEL));
        assertEq(uint8(registry.getStatus(_labelId())), uint8(IPermissionedRegistry.Status.AVAILABLE));
    }

    function test_renew_byOwnerExtends() public {
        _issue();
        vm.prank(alice);
        registry.renewMandate(LABEL, expiry + 1 days);
        assertEq(registry.getExpiry(_labelId()), expiry + 1 days);
        vm.warp(expiry);
        assertTrue(registry.isMandateActive(LABEL), "still live after the old expiry");
    }

    function test_renew_byAgentReverts() public {
        uint256 tokenId = _issue();
        bytes memory err = _missingRole(tokenId, RegistryRolesLib.ROLE_RENEW, agent);
        vm.prank(agent);
        vm.expectRevert(err);
        registry.renewMandate(LABEL, expiry + 1 days);
    }

    function test_renew_cannotReduceExpiry() public {
        _issue();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.CannotReduceExpiry.selector, expiry, expiry - 1));
        registry.renewMandate(LABEL, expiry - 1);
    }

    // ---- revocable ---------------------------------------------------------------------------

    function test_revoke_byOwnerIsImmediate() public {
        uint256 tokenId = _issue();
        vm.prank(alice);
        registry.revokeMandate(LABEL);
        assertEq(registry.ownerOf(tokenId), address(0));
        assertEq(registry.mandateAgent(LABEL), address(0));
        assertFalse(registry.isMandateActive(LABEL));
        assertEq(registry.getExpiry(_labelId()), uint64(block.timestamp), "expiry set to now");
    }

    function test_revoke_byAgentReverts() public {
        uint256 tokenId = _issue();
        bytes memory err = _missingRole(tokenId, RegistryRolesLib.ROLE_UNREGISTER, agent);
        vm.prank(agent);
        vm.expectRevert(err);
        registry.revokeMandate(LABEL);
    }

    function test_revoke_thenReissueToAnotherAgentGetsFreshToken() public {
        uint256 first = _issue();
        vm.prank(alice);
        registry.revokeMandate(LABEL);
        vm.prank(alice);
        uint256 second = registry.issueMandate(LABEL, buyer, resolver, expiry);
        assertTrue(first != second, "revoked token id is never reused");
        assertEq(registry.ownerOf(first), address(0));
        assertEq(registry.ownerOf(second), buyer);
    }

    // ---- non-transferable --------------------------------------------------------------------

    function test_transfer_byAgentReverts() public {
        uint256 tokenId = _issue();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenId, agent));
        registry.safeTransferFrom(agent, buyer, tokenId, 1, "");
        assertEq(registry.ownerOf(tokenId), agent);
    }

    function test_transfer_byApprovedOperatorReverts() public {
        uint256 tokenId = _issue();
        vm.prank(agent);
        registry.setApprovalForAll(buyer, true);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IStandardRegistry.TransferDisallowed.selector, tokenId, agent));
        registry.safeTransferFrom(agent, buyer, tokenId, 1, "");
    }

    function test_transferAdmin_cannotBeGrantedByOwnerOnToken() public {
        uint256 tokenId = _issue();
        vm.prank(alice);
        vm.expectRevert();
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, agent);
    }

    function test_transferAdmin_cannotBeGrantedOnRoot() public {
        vm.prank(alice);
        vm.expectRevert();
        registry.grantRootRoles(RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, alice);
    }

    function test_transferAdmin_cannotBeMintedWithRawRegister() public {
        vm.prank(alice);
        vm.expectRevert(AgentRailRegistry.TransferAdminForbidden.selector);
        registry.register(
            LABEL, agent, IRegistry(address(0)), resolver, RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, expiry
        );
    }

    // ---- the agent cannot widen its own authority ---------------------------------------------

    function test_agent_cannotChangeResolver() public {
        uint256 tokenId = _issue();
        bytes memory err = _missingRole(tokenId, RegistryRolesLib.ROLE_SET_RESOLVER, agent);
        vm.prank(agent);
        vm.expectRevert(err);
        registry.setResolver(tokenId, makeAddr("other"));
    }

    function test_agent_cannotGrantItselfRoles() public {
        uint256 tokenId = _issue();
        bytes memory err = abi.encodeWithSelector(
            IEnhancedAccessControl.EACCannotGrantRoles.selector,
            registry.getResource(tokenId),
            RegistryRolesLib.ROLE_RENEW,
            agent
        );
        vm.prank(agent);
        vm.expectRevert(err);
        registry.grantRoles(tokenId, RegistryRolesLib.ROLE_RENEW, agent);
    }

    function test_owner_holdsEveryLifecycleRoleAndNoTransferAdmin() public view {
        assertTrue(
            registry.hasRootRoles(
                RegistryRolesLib.ROLE_REGISTRAR | RegistryRolesLib.ROLE_RENEW | RegistryRolesLib.ROLE_UNREGISTER
                    | RegistryRolesLib.ROLE_SET_RESOLVER | RegistryRolesLib.ROLE_SET_SUBREGISTRY
                    | RegistryRolesLib.ROLE_SET_PARENT,
                alice
            )
        );
        assertFalse(registry.hasRootRoles(RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, alice));
    }
}
