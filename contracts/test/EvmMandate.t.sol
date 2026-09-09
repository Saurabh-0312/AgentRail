// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Test} from "forge-std/Test.sol";

import {EvmMandate} from "../src/EvmMandate.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Test names mirror tests/execute_payment.ts and tests/agentrail.ts so the parity is visible.
contract EvmMandateTest is Test {
    EvmMandate internal mandate;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal intruder = makeAddr("intruder");
    address internal shop = makeAddr("shop");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant USDC = 1e6;
    uint256 internal constant SPEND_LIMIT = 250_000;
    uint256 internal constant PER_TX_LIMIT = 100_000;
    uint256 internal constant DELEGATED = 1_000_000; // allowance is deliberately above the mandate caps

    bytes32 internal id;
    uint64 internal expiry;

    function setUp() public {
        mandate = new EvmMandate();
        usdc = new MockUSDC();
        usdc.mint(owner, 5 * USDC);
        expiry = uint64(block.timestamp + 1 hours);

        vm.startPrank(owner);
        id = mandate.createMandate(agent, bytes32(uint256(0x77)), expiry);
        mandate.addPermission(id, shop, SPEND_LIMIT, PER_TX_LIMIT);
        // The one-time setup: allowance to the mandate contract. No key is handed to the agent.
        usdc.approve(address(mandate), DELEGATED);
        vm.stopPrank();
    }

    function _pay(address to, uint256 amount) internal {
        vm.prank(agent);
        mandate.executePayment(id, address(usdc), to, amount);
    }

    function _expectPay(address to, uint256 amount, bytes4 err, address signer) internal {
        vm.prank(signer);
        vm.expectRevert(err);
        mandate.executePayment(id, address(usdc), to, amount);
    }

    // ---- create_mandate ------------------------------------------------------------------------

    function test_create_rejectsAnExpiryInThePast() public {
        vm.prank(owner);
        vm.expectRevert(EvmMandate.InvalidExpiry.selector);
        mandate.createMandate(intruder, bytes32(0), uint64(block.timestamp));
    }

    function test_create_createsAMandateWithEveryFieldSet() public view {
        (address o, address a, bytes32 node, uint64 e, bool active, uint256 len) = mandate.getMandate(id);
        assertEq(o, owner);
        assertEq(a, agent);
        assertEq(node, bytes32(uint256(0x77)));
        assertEq(e, expiry);
        assertTrue(active);
        assertEq(len, 1);
        assertEq(id, mandate.mandateIdFor(owner, agent), "id is deterministic in (owner, agent), like the PDA");
    }

    function test_create_rejectsASecondMandateForTheSameOwnerAndAgent() public {
        vm.prank(owner);
        vm.expectRevert(EvmMandate.MandateExists.selector);
        mandate.createMandate(agent, bytes32(0), expiry);
    }

    // ---- add_permission ------------------------------------------------------------------------

    function test_addPermission_rejectsASignerWhoIsNotTheOwner() public {
        vm.prank(agent);
        vm.expectRevert(EvmMandate.Unauthorized.selector);
        mandate.addPermission(id, attacker, 0, 0);
    }

    function test_addPermission_addsAPermissionAndStoresEveryField() public view {
        EvmMandate.Permission memory p = mandate.getPermission(id, shop);
        assertTrue(p.exists);
        assertEq(p.spendLimit, SPEND_LIMIT);
        assertEq(p.perTxLimit, PER_TX_LIMIT);
        assertEq(p.spendTotal, 0);
        assertEq(p.callCount, 0);
        assertEq(mandate.getDestinations(id)[0], shop);
    }

    function test_addPermission_rejectsADuplicateDestination() public {
        vm.prank(owner);
        vm.expectRevert(EvmMandate.DuplicatePermission.selector);
        mandate.addPermission(id, shop, 1, 1);
    }

    function test_addPermission_rejectsThe17thPermission() public {
        vm.startPrank(owner);
        for (uint256 i = 1; i < 16; ++i) {
            mandate.addPermission(id, address(uint160(0x1000 + i)), 0, 0);
        }
        (,,,,, uint256 len) = mandate.getMandate(id);
        assertEq(len, 16);
        vm.expectRevert(EvmMandate.PermissionsFull.selector);
        mandate.addPermission(id, address(uint160(0x2000)), 0, 0);
        vm.stopPrank();
    }

    // ---- remove_permission ---------------------------------------------------------------------

    function test_removePermission_rejectsASignerWhoIsNotTheOwner() public {
        vm.prank(agent);
        vm.expectRevert(EvmMandate.Unauthorized.selector);
        mandate.removePermission(id, shop);
    }

    function test_removePermission_rejectsADestinationThatHasNoEntry() public {
        vm.prank(owner);
        vm.expectRevert(EvmMandate.PermissionNotFound.selector);
        mandate.removePermission(id, attacker);
    }

    function test_removePermission_swapRemovesAndClearsTheEntry() public {
        vm.startPrank(owner);
        mandate.addPermission(id, attacker, 1, 1);
        mandate.removePermission(id, shop);
        vm.stopPrank();
        assertFalse(mandate.getPermission(id, shop).exists);
        address[] memory d = mandate.getDestinations(id);
        assertEq(d.length, 1);
        assertEq(d[0], attacker, "last entry moved into the vacated slot");
        _expectPay(shop, 1, EvmMandate.DestinationNotAllowed.selector, agent);
    }

    // ---- execute_payment -----------------------------------------------------------------------

    function test_agentCannotTransferDirectly_itHoldsNoAuthority() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, agent, 0, 1)
        );
        usdc.transferFrom(owner, shop, 1);
        assertEq(usdc.balanceOf(shop), 0);
    }

    function test_paysWithinTheCapsAndTheBalancesMove() public {
        uint256 before = usdc.balanceOf(owner);
        _pay(shop, 60_000);
        assertEq(usdc.balanceOf(shop), 60_000);
        assertEq(usdc.balanceOf(owner), before - 60_000);
        assertEq(usdc.balanceOf(address(mandate)), 0, "no vault: tokens never sit in the contract");
        assertEq(usdc.allowance(owner, address(mandate)), DELEGATED - 60_000);

        EvmMandate.Permission memory p = mandate.getPermission(id, shop);
        assertEq(p.spendTotal, 60_000);
        assertEq(p.callCount, 1);
    }

    function test_rejectsADestinationThatIsNotOnTheAllowedList() public {
        _expectPay(attacker, 1, EvmMandate.DestinationNotAllowed.selector, agent);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_rejectsASignerWhoIsNotTheMandatedAgent() public {
        _expectPay(shop, 1, EvmMandate.NotTheAgent.selector, intruder);
        _expectPay(shop, 1, EvmMandate.NotTheAgent.selector, owner);
    }

    function test_rejectsAnAmountOverThePerTransactionCap() public {
        _expectPay(shop, PER_TX_LIMIT + 1, EvmMandate.PerTxLimitExceeded.selector, agent);
        assertEq(usdc.balanceOf(shop), 0, "nothing moved");
    }

    function test_rejectsAnAmountThatWouldBreachTheLifetimeCap() public {
        // 100_000 + 100_000 fits under 250_000; the third 100_000 does not; 50_000 does, exactly.
        _pay(shop, 100_000);
        _pay(shop, 100_000);
        _expectPay(shop, 100_000, EvmMandate.SpendLimitExceeded.selector, agent);
        _pay(shop, 50_000);
        assertEq(usdc.balanceOf(shop), SPEND_LIMIT);
        assertEq(mandate.getPermission(id, shop).spendTotal, SPEND_LIMIT);
        _expectPay(shop, 1, EvmMandate.SpendLimitExceeded.selector, agent);
    }

    function test_doesNotRecordASpendWhenTheTransferItselfFails() public {
        // Caps above the allowance: the mandate passes, the token refuses.
        vm.prank(owner);
        usdc.approve(address(mandate), 10);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(mandate), 10, 11)
        );
        mandate.executePayment(id, address(usdc), shop, 11);
        EvmMandate.Permission memory p = mandate.getPermission(id, shop);
        assertEq(p.spendTotal, 0);
        assertEq(p.callCount, 0);
    }

    function test_rejectsOnceTheMandateHasExpired() public {
        vm.warp(expiry);
        _expectPay(shop, 1, EvmMandate.Expired.selector, agent);
        assertEq(mandate.check(id, agent, shop, 1), EvmMandate.Expired.selector);
    }

    function test_rejectsAfterTheOwnerRevokesTheMandate_evenThoughTheAllowanceStillPointsAtIt() public {
        vm.prank(owner);
        mandate.revokeMandate(id);
        assertEq(usdc.allowance(owner, address(mandate)), DELEGATED, "allowance untouched");
        _expectPay(shop, 1, EvmMandate.NotActive.selector, agent);
        assertEq(usdc.balanceOf(shop), 0, "nothing moved");
        assertEq(mandate.getDestinations(id).length, 0);
        assertFalse(mandate.getPermission(id, shop).exists);
    }

    function test_revoke_rejectsASignerWhoIsNotTheOwner() public {
        vm.prank(agent);
        vm.expectRevert(EvmMandate.Unauthorized.selector);
        mandate.revokeMandate(id);
    }

    function test_revoke_thenReissueStartsClean() public {
        _pay(shop, 60_000);
        vm.startPrank(owner);
        mandate.revokeMandate(id);
        bytes32 again = mandate.createMandate(agent, bytes32(0), expiry);
        vm.stopPrank();
        assertEq(again, id, "same (owner, agent) => same id");
        (,,,,, uint256 len) = mandate.getMandate(id);
        assertEq(len, 0);
        assertEq(mandate.getPermission(id, shop).spendTotal, 0);
    }

    // ---- authorize: the gate for value that settles on an external rail -----------------------

    function test_authorize_recordsWithoutMovingValue() public {
        uint256 before = usdc.balanceOf(owner);
        vm.prank(agent);
        mandate.authorize(id, shop, 40_000, keccak256("x402:/price/SOL"));
        assertEq(usdc.balanceOf(owner), before, "nothing moved on-chain");
        EvmMandate.Permission memory p = mandate.getPermission(id, shop);
        assertEq(p.spendTotal, 40_000);
        assertEq(p.callCount, 1);
    }

    function test_authorize_andExecutePayment_shareOneLedger() public {
        vm.prank(agent);
        mandate.authorize(id, shop, 100_000, bytes32(0));
        _pay(shop, 100_000);
        vm.prank(agent);
        mandate.authorize(id, shop, 50_000, bytes32(0));
        assertEq(mandate.getPermission(id, shop).spendTotal, SPEND_LIMIT);
        vm.prank(agent);
        vm.expectRevert(EvmMandate.SpendLimitExceeded.selector);
        mandate.authorize(id, shop, 1, bytes32(0));
    }

    function test_authorize_refusesEverythingExecutePaymentRefuses() public {
        vm.startPrank(agent);
        vm.expectRevert(EvmMandate.DestinationNotAllowed.selector);
        mandate.authorize(id, attacker, 1, bytes32(0));
        vm.expectRevert(EvmMandate.PerTxLimitExceeded.selector);
        mandate.authorize(id, shop, PER_TX_LIMIT + 1, bytes32(0));
        vm.stopPrank();
        vm.prank(intruder);
        vm.expectRevert(EvmMandate.NotTheAgent.selector);
        mandate.authorize(id, shop, 1, bytes32(0));
    }

    function test_check_isADryRunOfTheGate() public view {
        assertEq(mandate.check(id, agent, shop, 1), bytes4(0));
        assertEq(mandate.check(id, agent, attacker, 1), EvmMandate.DestinationNotAllowed.selector);
        assertEq(mandate.check(id, intruder, shop, 1), EvmMandate.NotTheAgent.selector);
        assertEq(mandate.check(id, agent, shop, PER_TX_LIMIT + 1), EvmMandate.PerTxLimitExceeded.selector);
        assertEq(mandate.check(id, agent, shop, SPEND_LIMIT + 1), EvmMandate.PerTxLimitExceeded.selector);
        assertEq(mandate.check(bytes32(0), agent, shop, 1), EvmMandate.NotActive.selector);
    }
}
