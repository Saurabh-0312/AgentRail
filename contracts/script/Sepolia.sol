// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRegistry} from "@ens-v2/registry/interfaces/IRegistry.sol";
import {PermissionedResolverLib} from "@ens-v2/resolver/libraries/PermissionedResolverLib.sol";

/// @dev ENSv2 on Sepolia: ensdomains/contracts-v2 :: contracts/deployments/sepolia
library Sepolia {
    address internal constant LABEL_STORE = 0xB03524289C16424f71802A1794c29c7Bd1B9f577;
    address internal constant ETH_REGISTRY = 0x67b728a792e789a8978b30cF1b3b641f19354b43;
    address internal constant ETH_REGISTRAR = 0xa4449a0dD2b83007553D9b1d28b583A46A805a30;
    address internal constant PERMISSIONED_RESOLVER_IMPL = 0x7E4B2d59938930168024201752EE5503df402303;
    address internal constant MOCK_USDC = 0xD3322B29a7BdEe707D1684676f149bf41Aa3422f;

    /// @dev Root roles the registry owner takes on the resolver proxy: text and addr, plus their admins.
    uint256 internal constant RESOLVER_OWNER_ROLES =
        PermissionedResolverLib.ROLE_SET_TEXT |
            PermissionedResolverLib.ROLE_SET_TEXT_ADMIN |
            PermissionedResolverLib.ROLE_SET_ADDR |
            PermissionedResolverLib.ROLE_SET_ADDR_ADMIN;
}

/// @dev Commit-reveal registrar for .eth names on ENSv2.
interface IETHRegistrar {
    function isAvailable(string memory label) external view returns (bool);
    function commitmentAt(bytes32 commitment) external view returns (uint64);
    function makeCommitment(
        string calldata label,
        address owner,
        bytes32 secret,
        address subregistry,
        address resolver,
        uint64 duration,
        bytes32 referrer
    ) external pure returns (bytes32);
    function commit(bytes32 commitment) external;
    function register(
        string memory label,
        address owner,
        bytes32 secret,
        IRegistry subregistry,
        address resolver,
        uint64 duration,
        address paymentToken,
        bytes32 referrer
    ) external returns (uint256 tokenId);
}

interface IMockUSDC {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev The slice of PermissionedResolver the deployment touches.
interface IRailResolver {
    function initialize(address admin, uint256 roleBitmap, bytes[] calldata setters) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
    function authorizeTextRoles(bytes calldata toName, string calldata key, address account, bool grant)
        external
        returns (bool);
}
