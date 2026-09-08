// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";

interface ITextResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
    function setText(bytes32 node, string calldata key, string calldata value) external;
}

/// A contract that reads an ENS text record synchronously: the thing spike 3 must prove is possible.
contract OnchainReader {
    function read(address resolver, bytes32 node, string calldata key) external view returns (string memory) {
        return ITextResolver(resolver).text(node, key);
    }

    /// Diagnostic: returns the revert selector instead of bubbling, so an OffchainLookup can be named.
    function probe(address resolver, bytes32 node, string calldata key)
        external
        view
        returns (bool ok, string memory value, bytes4 selector)
    {
        try ITextResolver(resolver).text(node, key) returns (string memory v) {
            return (true, v, bytes4(0));
        } catch (bytes memory err) {
            bytes4 sel;
            if (err.length >= 4) {
                assembly {
                    sel := mload(add(err, 32))
                }
            }
            return (false, "", sel);
        }
    }
}

/// Spike 3: ENSv2 resolvers on Sepolia expose `text()` as a plain synchronous view, with no OffchainLookup revert.
/// Run: forge test --match-contract Spike3 --fork-url $SEPOLIA_RPC_URL -vv
contract Spike3ENSv2ReadTest is Test {
    // ensdomains/contracts-v2 :: contracts/deployments/sepolia
    address constant PERMISSIONED_RESOLVER_IMPL = 0x7E4B2d59938930168024201752EE5503df402303;
    address constant PUBLIC_RESOLVER_V2 = 0xd25f66Dd4fF61486c2c5c1E6201A23576698D3df;
    address constant ENS_V2_RESOLVER = 0x6F988f299926cE361450dB390D66dD604dcd8b21;

    bytes4 constant OFFCHAIN_LOOKUP = 0x556f1830; // OffchainLookup(address,string[],bytes,bytes4,bytes)

    OnchainReader reader;
    bytes32 node = keccak256("agentrail.spike3.node");

    function setUp() public {
        reader = new OnchainReader();
    }

    function test_PermissionedResolver_text_is_synchronous() public view {
        (bool ok, string memory v, bytes4 sel) = reader.probe(PERMISSIONED_RESOLVER_IMPL, node, "rail.status");
        assertTrue(ok, "text() must not revert");
        assertTrue(sel != OFFCHAIN_LOOKUP, "must not be OffchainLookup");
        assertEq(bytes(v).length, 0, "unset record reads as empty string");
        console2.log("PermissionedResolverImpl.text(): synchronous, returned empty string");
    }

    function test_PublicResolverV2_text_is_synchronous() public view {
        (bool ok, string memory v, bytes4 sel) = reader.probe(PUBLIC_RESOLVER_V2, node, "rail.status");
        assertTrue(ok, "text() must not revert");
        assertTrue(sel != OFFCHAIN_LOOKUP, "must not be OffchainLookup");
        assertEq(bytes(v).length, 0);
        console2.log("PublicResolverV2.text(): synchronous, returned empty string");
    }

    /// Diagnostic only: ENSV2Resolver is the v1->v2 mirror and its artifact references OffchainLookup.
    function test_ENSV2Resolver_text_probe() public view {
        (bool ok,, bytes4 sel) = reader.probe(ENS_V2_RESOLVER, node, "rail.status");
        if (ok) {
            console2.log("ENSV2Resolver.text(): synchronous");
        } else if (sel == OFFCHAIN_LOOKUP) {
            console2.log("ENSV2Resolver.text(): reverted with OffchainLookup (CCIP-Read path) - not our target resolver");
        } else {
            console2.log("ENSV2Resolver.text(): reverted, selector:");
            console2.logBytes4(sel);
        }
    }

    /// Unauthorized setText must revert: the per-key role gate is live on real bytecode.
    function test_PermissionedResolver_setText_unauthorized_reverts() public {
        vm.expectRevert();
        ITextResolver(PERMISSIONED_RESOLVER_IMPL).setText(node, "rail.status", "active");
    }
}
