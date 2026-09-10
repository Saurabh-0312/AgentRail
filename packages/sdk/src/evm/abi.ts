import { parseAbi, toFunctionSelector } from "viem";

/** The slice of contracts/src/EvmMandate.sol the adapter uses, plus every custom error it can throw. */
export const EVM_MANDATE_ABI = parseAbi([
  "function createMandate(address agent, bytes32 ensNode, uint64 expiry) returns (bytes32)",
  "function addPermission(bytes32 mandateId, address destination, uint256 spendLimit, uint256 perTxLimit)",
  "function removePermission(bytes32 mandateId, address destination)",
  "function revokeMandate(bytes32 mandateId)",
  "function executePayment(bytes32 mandateId, address token, address destination, uint256 amount)",
  "function authorize(bytes32 mandateId, address destination, uint256 amount, bytes32 ref)",
  "function mandateIdFor(address owner, address agent) pure returns (bytes32)",
  "function getMandate(bytes32 mandateId) view returns (address owner, address agent, bytes32 ensNode, uint64 expiry, bool active, uint256 permissionsLen)",
  "function getPermission(bytes32 mandateId, address destination) view returns ((uint256 spendLimit, uint256 perTxLimit, uint256 spendTotal, uint32 callCount, bool exists))",
  "function getDestinations(bytes32 mandateId) view returns (address[])",
  "function check(bytes32 mandateId, address agent, address destination, uint256 amount) view returns (bytes4)",
  "error NotActive()",
  "error Expired()",
  "error PermissionsFull()",
  "error PermissionNotFound()",
  "error DuplicatePermission()",
  "error PerTxLimitExceeded()",
  "error SpendLimitExceeded()",
  "error Unauthorized()",
  "error NotTheAgent()",
  "error InvalidExpiry()",
  "error DestinationNotAllowed()",
  "error MandateExists()",
  "error ZeroAgent()",
]);

/** Map a `check()` selector back to the error name the Solana program would have used. */
export const EVM_MANDATE_ERRORS: Record<string, string> = Object.fromEntries(
  [
    "NotActive",
    "Expired",
    "PermissionsFull",
    "PermissionNotFound",
    "DuplicatePermission",
    "PerTxLimitExceeded",
    "SpendLimitExceeded",
    "Unauthorized",
    "NotTheAgent",
    "InvalidExpiry",
    "DestinationNotAllowed",
    "MandateExists",
    "ZeroAgent",
  ].map((name) => [toFunctionSelector(`${name}()`), name]),
);

export const NO_ERROR = "0x00000000";
