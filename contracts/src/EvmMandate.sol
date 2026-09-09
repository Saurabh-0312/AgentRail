// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EvmMandate
/// @notice The EVM twin of the AgentRail Solana program. One artifact, deployed to Hedera testnet
///         and Base Sepolia, so a mandate is enforced natively on both VMs.
///
/// Same model, same names as the Solana gate:
///  - a mandate is keyed by (owner, agent), like the `["mandate", owner, agent]` PDA
///  - permissions are keyed by destination and carry a per-tx and a lifetime cap
///  - the owner mutates, the agent spends, nobody else does anything
///  - checks run cheapest first: active -> expiry -> agent -> destination -> per-tx -> lifetime
///
/// Two spend paths share one gate:
///  - `executePayment` pulls ERC-20 value from the owner's own balance via allowance, the EVM
///    equivalent of SPL `approve` to the mandate PDA. Tokens never sit in this contract.
///  - `authorize` runs the gate and records the spend for value that settles on an external rail
///    (an x402 facilitator). It is called BEFORE any facilitator is contacted; if the mandate
///    refuses, no payment is ever signed.
contract EvmMandate {
    using SafeERC20 for IERC20;

    ////////////////////////////////////////////////////////////////////////
    // Types
    ////////////////////////////////////////////////////////////////////////

    struct Permission {
        uint256 spendLimit; // lifetime cap, 0 = unlimited
        uint256 perTxLimit; // per-tx cap, 0 = unlimited
        uint256 spendTotal;
        uint32 callCount;
        bool exists;
    }

    struct Mandate {
        address owner;
        address agent;
        bytes32 ensNode;
        uint64 expiry;
        bool active;
        address[] destinations;
        mapping(address destination => Permission) permissions;
    }

    ////////////////////////////////////////////////////////////////////////
    // Constants
    ////////////////////////////////////////////////////////////////////////

    uint256 public constant MAX_PERMISSIONS = 16;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    mapping(bytes32 mandateId => Mandate) internal _mandates;

    ////////////////////////////////////////////////////////////////////////
    // Events
    ////////////////////////////////////////////////////////////////////////

    event MandateCreated(bytes32 indexed mandateId, address indexed owner, address indexed agent, bytes32 ensNode, uint64 expiry);
    event PermissionAdded(bytes32 indexed mandateId, address indexed destination, uint256 spendLimit, uint256 perTxLimit);
    event PermissionRemoved(bytes32 indexed mandateId, address indexed destination);
    event MandateRevoked(bytes32 indexed mandateId);
    /// @notice Value moved from the owner to `destination` through the gate.
    event PaymentExecuted(bytes32 indexed mandateId, address indexed destination, address indexed token, uint256 amount, uint256 spendTotal);
    /// @notice The gate passed and the spend was recorded; settlement happens on an external rail.
    event SpendAuthorized(bytes32 indexed mandateId, address indexed destination, uint256 amount, uint256 spendTotal, bytes32 ref);

    ////////////////////////////////////////////////////////////////////////
    // Errors -- the Solana program's names, in the Solana program's order
    ////////////////////////////////////////////////////////////////////////

    error NotActive(); // 6000
    error Expired(); // 6001
    error PermissionsFull(); // 6002
    error PermissionNotFound(); // 6003
    error DuplicatePermission(); // 6004
    error PerTxLimitExceeded(); // 6007
    error SpendLimitExceeded(); // 6008
    error Unauthorized(); // 6009
    error NotTheAgent(); // 6010
    error InvalidExpiry(); // 6013
    error DestinationNotAllowed(); // 6016
    error MandateExists(); // EVM only: the Solana `init` fails at the system program instead
    error ZeroAgent();

    ////////////////////////////////////////////////////////////////////////
    // Owner path
    ////////////////////////////////////////////////////////////////////////

    /// @notice Issue a mandate for `agent`. The id is deterministic in (owner, agent), like the PDA.
    function createMandate(address agent, bytes32 ensNode, uint64 expiry) external returns (bytes32 mandateId) {
        if (agent == address(0)) revert ZeroAgent();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        mandateId = mandateIdFor(msg.sender, agent);
        Mandate storage m = _mandates[mandateId];
        if (m.active) revert MandateExists();
        m.owner = msg.sender;
        m.agent = agent;
        m.ensNode = ensNode;
        m.expiry = expiry;
        m.active = true;
        emit MandateCreated(mandateId, msg.sender, agent, ensNode, expiry);
    }

    /// @notice Allow payments to `destination` under the given caps.
    function addPermission(bytes32 mandateId, address destination, uint256 spendLimit, uint256 perTxLimit) external {
        Mandate storage m = _owned(mandateId);
        if (m.destinations.length >= MAX_PERMISSIONS) revert PermissionsFull();
        Permission storage p = m.permissions[destination];
        if (p.exists) revert DuplicatePermission();
        p.spendLimit = spendLimit;
        p.perTxLimit = perTxLimit;
        p.exists = true;
        m.destinations.push(destination);
        emit PermissionAdded(mandateId, destination, spendLimit, perTxLimit);
    }

    /// @notice Swap-remove the permission for `destination`. Order is irrelevant.
    function removePermission(bytes32 mandateId, address destination) external {
        Mandate storage m = _owned(mandateId);
        if (!m.permissions[destination].exists) revert PermissionNotFound();
        delete m.permissions[destination];
        uint256 len = m.destinations.length;
        for (uint256 i; i < len; ++i) {
            if (m.destinations[i] == destination) {
                m.destinations[i] = m.destinations[len - 1];
                m.destinations.pop();
                break;
            }
        }
        emit PermissionRemoved(mandateId, destination);
    }

    /// @notice Kill the mandate. Every permission goes with it; the id can be re-issued later.
    function revokeMandate(bytes32 mandateId) external {
        Mandate storage m = _owned(mandateId);
        address[] memory destinations = m.destinations;
        for (uint256 i; i < destinations.length; ++i) {
            delete m.permissions[destinations[i]];
        }
        delete _mandates[mandateId];
        emit MandateRevoked(mandateId);
    }

    ////////////////////////////////////////////////////////////////////////
    // Agent path
    ////////////////////////////////////////////////////////////////////////

    /// @notice Pay `amount` of `token` from the owner's balance to `destination`, if the mandate allows it.
    /// @dev The owner must have approved this contract for at least `amount`. The gate runs first;
    ///      nothing is pulled unless every check passes, and the spend is recorded after the transfer.
    function executePayment(bytes32 mandateId, address token, address destination, uint256 amount) external {
        Mandate storage m = _mandates[mandateId];
        Permission storage p = _gate(m, destination, amount);
        IERC20(token).safeTransferFrom(m.owner, destination, amount);
        _record(p, amount);
        emit PaymentExecuted(mandateId, destination, token, amount, p.spendTotal);
    }

    /// @notice Run the gate for a payment that settles elsewhere and record the spend.
    /// @param ref Opaque tag for the settlement (e.g. the x402 resource hash) for the audit trail.
    function authorize(bytes32 mandateId, address destination, uint256 amount, bytes32 ref) external {
        Mandate storage m = _mandates[mandateId];
        Permission storage p = _gate(m, destination, amount);
        _record(p, amount);
        emit SpendAuthorized(mandateId, destination, amount, p.spendTotal, ref);
    }

    ////////////////////////////////////////////////////////////////////////
    // Views
    ////////////////////////////////////////////////////////////////////////

    function mandateIdFor(address owner, address agent) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, agent));
    }

    function getMandate(bytes32 mandateId)
        external
        view
        returns (address owner, address agent, bytes32 ensNode, uint64 expiry, bool active, uint256 permissionsLen)
    {
        Mandate storage m = _mandates[mandateId];
        return (m.owner, m.agent, m.ensNode, m.expiry, m.active, m.destinations.length);
    }

    function getPermission(bytes32 mandateId, address destination) external view returns (Permission memory) {
        return _mandates[mandateId].permissions[destination];
    }

    function getDestinations(bytes32 mandateId) external view returns (address[] memory) {
        return _mandates[mandateId].destinations;
    }

    /// @notice Dry-run the gate. Returns the revert selector the spend path would throw, or zero.
    function check(bytes32 mandateId, address agent, address destination, uint256 amount) external view returns (bytes4) {
        Mandate storage m = _mandates[mandateId];
        if (!m.active) return NotActive.selector;
        if (block.timestamp >= m.expiry) return Expired.selector;
        if (agent != m.agent) return NotTheAgent.selector;
        Permission storage p = m.permissions[destination];
        if (!p.exists) return DestinationNotAllowed.selector;
        if (p.perTxLimit != 0 && amount > p.perTxLimit) return PerTxLimitExceeded.selector;
        if (p.spendLimit != 0 && p.spendTotal + amount > p.spendLimit) return SpendLimitExceeded.selector;
        return bytes4(0);
    }

    ////////////////////////////////////////////////////////////////////////
    // Internal
    ////////////////////////////////////////////////////////////////////////

    function _owned(bytes32 mandateId) internal view returns (Mandate storage m) {
        m = _mandates[mandateId];
        if (!m.active) revert NotActive();
        if (m.owner != msg.sender) revert Unauthorized();
    }

    /// @dev Fail-fast, cheapest first: active -> expiry -> agent -> destination -> per-tx -> lifetime.
    function _gate(Mandate storage m, address destination, uint256 amount) internal view returns (Permission storage p) {
        if (!m.active) revert NotActive();
        if (block.timestamp >= m.expiry) revert Expired();
        if (msg.sender != m.agent) revert NotTheAgent();
        p = m.permissions[destination];
        if (!p.exists) revert DestinationNotAllowed();
        if (p.perTxLimit != 0 && amount > p.perTxLimit) revert PerTxLimitExceeded();
        if (p.spendLimit != 0 && p.spendTotal + amount > p.spendLimit) revert SpendLimitExceeded();
    }

    function _record(Permission storage p, uint256 amount) internal {
        p.spendTotal += amount;
        ++p.callCount;
    }
}
