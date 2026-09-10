// Shared helpers for both subgraphs. Pure functions; every one is covered by matchstick tests.
import { BigInt, Bytes, JSONValue, JSONValueKind, TypedMap, crypto, json } from "@graphprotocol/graph-ts";

export const CHAIN_SEPOLIA = "sepolia";
export const CHAIN_BASE = "base";
export const CHAIN_SOLANA = "solana";

/** namehash("agentrail.eth"): every name this registry issues is <label>.agentrail.eth. */
export const PARENT_NODE = Bytes.fromHexString("0xa8000cc4a2b775ac4243d66028f373b831eb4e4f43368868993e1bafa534eda8");
export const PARENT_NAME = "agentrail.eth";

/** Mandate.id: the join key plus the chain. */
export function mandateId(ensNode: Bytes, chain: string): string {
  return ensNode.toHexString() + ":" + chain;
}

/** ENS namehash step: keccak256(parentNode ‖ labelHash). */
export function childNode(parentNode: Bytes, labelHash: Bytes): Bytes {
  const packed = new Uint8Array(64);
  packed.set(parentNode, 0);
  packed.set(labelHash, 32);
  return Bytes.fromByteArray(crypto.keccak256(Bytes.fromUint8Array(packed)));
}

/** namehash of <label>.agentrail.eth from the LabelRegistered labelHash. */
export function nodeForLabelHash(labelHash: Bytes): Bytes {
  return childNode(PARENT_NODE, labelHash);
}

/** Bytes for a uint256 tokenId, as the registry's ERC-1155 id. */
export function tokenKey(tokenId: BigInt): string {
  return tokenId.toString();
}

/** True for a non-empty string of ASCII digits (what rail.price must be). */
export function isDigits(s: string): boolean {
  if (s.length == 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** Classify an ERC-8004 agentURI the way the Agent0 subgraph does. */
export function uriType(uri: string): string {
  if (uri.startsWith("ipfs://")) return "ipfs";
  if (uri.startsWith("https://")) return "https";
  if (uri.startsWith("http://")) return "http";
  if (uri.startsWith("data:")) return "data";
  return "unknown";
}

/** `eip155:11155111:0x8004…:10190` -> Agent id `11155111:10190`, or null when malformed. */
export function agentIdFromErc8004(record: string): string | null {
  const parts = record.split(":");
  if (parts.length != 4 || parts[0] != "eip155") return null;
  if (parts[1].length == 0 || parts[3].length == 0) return null;
  return parts[1] + ":" + parts[3];
}

// ---- base58 (Solana pubkeys) --------------------------------------------------------------------

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 string into bytes. Returns null on an invalid character. */
export function base58Decode(s: string): Bytes | null {
  // big-number accumulation in base 256
  const bytes = new Array<u8>();
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    let carry = ALPHABET.indexOf(c);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as i32) * 58;
      bytes[j] = (carry & 0xff) as u8;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push((carry & 0xff) as u8);
      carry >>= 8;
    }
  }
  // leading '1's are leading zero bytes
  for (let i = 0; i < s.length && s.charAt(i) == "1"; i++) bytes.push(0);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return Bytes.fromUint8Array(out);
}

/**
 * The payee bytes for an allow-list entry: 20-byte address on EVM chains, 32-byte pubkey on
 * Solana, UTF-8 account id on Hedera. Unknown chains fall back to UTF-8 so nothing is dropped.
 */
export function targetBytes(chain: string, target: string): Bytes {
  if (chain.startsWith("eip155:")) return Bytes.fromHexString(target);
  if (chain.startsWith("solana:")) {
    const decoded = base58Decode(target);
    if (decoded !== null) return decoded;
  }
  return Bytes.fromUTF8(target);
}

// ---- rail.allowed ---------------------------------------------------------------------------------

export class AllowedEntry {
  chain: string;
  target: string;
  perTx: BigInt;
  total: BigInt;
  mint: string;
  constructor(chain: string, target: string, perTx: BigInt, total: BigInt, mint: string) {
    this.chain = chain;
    this.target = target;
    this.perTx = perTx;
    this.total = total;
    this.mint = mint;
  }
}

function stringField(obj: TypedMap<string, JSONValue>, key: string): string {
  const v = obj.get(key);
  if (v === null || v.kind != JSONValueKind.STRING) return "";
  return v.toString();
}

function bigIntField(obj: TypedMap<string, JSONValue>, key: string): BigInt {
  const v = obj.get(key);
  if (v === null) return BigInt.zero();
  if (v.kind == JSONValueKind.STRING) {
    const s = v.toString();
    return isDigits(s) ? BigInt.fromString(s) : BigInt.zero();
  }
  if (v.kind == JSONValueKind.NUMBER) return v.toBigInt();
  return BigInt.zero();
}

/** Parse the rail.allowed JSON array. Malformed input yields an empty list, never a crash. */
export function parseAllowed(raw: string): AllowedEntry[] {
  const out = new Array<AllowedEntry>();
  const parsed = json.try_fromString(raw);
  if (parsed.isError || parsed.value.kind != JSONValueKind.ARRAY) return out;
  const items = parsed.value.toArray();
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind != JSONValueKind.OBJECT) continue;
    const obj = items[i].toObject();
    const chain = stringField(obj, "chain");
    const target = stringField(obj, "target");
    if (chain.length == 0 || target.length == 0) continue;
    out.push(new AllowedEntry(chain, target, bigIntField(obj, "perTx"), bigIntField(obj, "total"), stringField(obj, "mint")));
  }
  return out;
}

export function allowlistPermissionId(ensNode: Bytes, chain: string, target: string): string {
  return ensNode.toHexString() + ":" + CHAIN_SEPOLIA + ":allowlist:" + chain + ":" + target;
}
