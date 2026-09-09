// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {RegistryRolesLib} from "@ens-v2/registry/libraries/RegistryRolesLib.sol";
import {PermissionedRegistry} from "@ens-v2/registry/PermissionedRegistry.sol";
import {ILabelStore} from "@ens-v2/utils/interfaces/ILabelStore.sol";
import {LibLabel} from "@ens-v2/utils/LibLabel.sol";

/// @title AgentRailRegistry
/// @notice An ENSv2 subname registry in which every subname is a mandate for one AI agent.
///
/// The three properties of a mandate are the subname's own ENS lifecycle, not text records:
///  - Expiring: ENS's `expiry`. The name is AVAILABLE the moment `block.timestamp >= expiry`.
///  - Revocable: `unregister()` sets the expiry to now. The agent is gone in one transaction.
///  - Non-transferable: `ROLE_CAN_TRANSFER_ADMIN` can never be granted in this registry, so
///    `safeTransferFrom` always reverts with `TransferDisallowed`. Authority cannot be sold.
///
/// The agent owns the subname token and holds no roles on it: it cannot renew, revoke, re-point or
/// transfer its own name. The registry owner holds the root roles and does all of that.
contract AgentRailRegistry is PermissionedRegistry {
    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    /// @notice A mandate was issued: `label` now names `agent` until `expiry`.
    event MandateIssued(
        uint256 indexed tokenId,
        string label,
        address indexed agent,
        uint64 expiry,
        address resolver
    );

    ////////////////////////////////////////////////////////////////////////
    // Errors
    ////////////////////////////////////////////////////////////////////////

    /// @notice `ROLE_CAN_TRANSFER_ADMIN` is never grantable here.
    error TransferAdminForbidden();

    /// @notice A mandate needs an agent.
    error ZeroAgent();

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    /// @dev Root roles for the registry owner. Every lifecycle role and its admin, and nothing that
    ///      touches transferability.
    uint256 internal constant OWNER_ROOT_ROLES =
        RegistryRolesLib.ROLE_REGISTRAR |
            RegistryRolesLib.ROLE_REGISTRAR_ADMIN |
            RegistryRolesLib.ROLE_REGISTER_RESERVED |
            RegistryRolesLib.ROLE_REGISTER_RESERVED_ADMIN |
            RegistryRolesLib.ROLE_RENEW |
            RegistryRolesLib.ROLE_RENEW_ADMIN |
            RegistryRolesLib.ROLE_UNREGISTER |
            RegistryRolesLib.ROLE_UNREGISTER_ADMIN |
            RegistryRolesLib.ROLE_SET_RESOLVER |
            RegistryRolesLib.ROLE_SET_RESOLVER_ADMIN |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY |
            RegistryRolesLib.ROLE_SET_SUBREGISTRY_ADMIN |
            RegistryRolesLib.ROLE_SET_PARENT |
            RegistryRolesLib.ROLE_SET_PARENT_ADMIN |
            RegistryRolesLib.ROLE_SET_URI |
            RegistryRolesLib.ROLE_SET_URI_ADMIN;

    ////////////////////////////////////////////////////////////////////////
    // Initialization
    ////////////////////////////////////////////////////////////////////////

    /// @param labelStore The shared ENSv2 label database.
    /// @param owner The human who issues mandates. Receives every root role except transfer admin.
    constructor(ILabelStore labelStore, address owner)
        PermissionedRegistry(labelStore, owner, OWNER_ROOT_ROLES)
    {}

    ////////////////////////////////////////////////////////////////////////
    // Mandate lifecycle
    ////////////////////////////////////////////////////////////////////////

    /// @notice Issue a mandate: mint `label` to `agent`, expiring at `expiry`, with no token roles.
    /// @dev Requires `ROLE_REGISTRAR` on the root resource (the owner). Reverts through
    ///      `PermissionedRegistry` if the label is live or the expiry is in the past.
    /// @param label The subname label, e.g. "databot" for databot.alice.eth.
    /// @param agent The agent's address. Becomes the token owner, holds no roles.
    /// @param resolver The resolver carrying the `rail.*` records.
    /// @param expiry Unix time at which the mandate ends. ENS enforces it.
    /// @return tokenId The ERC1155 token id of the subname.
    function issueMandate(string calldata label, address agent, address resolver, uint64 expiry)
        external
        returns (uint256 tokenId)
    {
        if (agent == address(0)) {
            revert ZeroAgent();
        }
        tokenId = register(label, agent, IRegistry(address(0)), resolver, 0, expiry);
        emit MandateIssued(tokenId, label, agent, expiry, resolver);
    }

    /// @notice Extend a mandate. Requires `ROLE_RENEW`; the agent never has it.
    function renewMandate(string calldata label, uint64 newExpiry) external {
        renew(LibLabel.id(label), newExpiry);
    }

    /// @notice Revoke a mandate now. Requires `ROLE_UNREGISTER`; the agent never has it.
    function revokeMandate(string calldata label) external {
        unregister(LibLabel.id(label));
    }

    /// @notice The agent named by `label`, or the zero address once expired or revoked.
    function mandateAgent(string calldata label) external view returns (address) {
        return getOwner(LibLabel.id(label));
    }

    /// @notice True while the mandate is live: registered and not yet expired.
    function isMandateActive(string calldata label) external view returns (bool) {
        return getStatus(LibLabel.id(label)) == Status.REGISTERED;
    }

    ////////////////////////////////////////////////////////////////////////
    // Non-transferability, enforced structurally
    ////////////////////////////////////////////////////////////////////////

    /// @dev Every role grant in the registry passes through here, including the constructor's and
    ///      `register()`'s. Refusing the transfer-admin bit at this choke point means no token in
    ///      this registry can ever satisfy the transfer check in `PermissionedRegistry._update`.
    function _grantRoles(uint256 resource, uint256 roleBitmap, address account, bool executeCallbacks)
        internal
        virtual
        override
        returns (bool)
    {
        if (roleBitmap & RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN != 0) {
            revert TransferAdminForbidden();
        }
        return super._grantRoles(resource, roleBitmap, account, executeCallbacks);
    }
}
