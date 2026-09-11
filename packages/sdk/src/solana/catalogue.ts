/**
 * The instruction catalogue: which programs a Solana mandate can name, which instructions each
 * one has, the tag the program reads, and how wide the discriminator is. The width is the part
 * that bites (SPEC §9 flaw 2): SPL Token compares one byte, the System Program a u32, Anchor
 * programs eight bytes. A wrong width silently compares argument data and the gate stops meaning
 * what the owner thinks it means, so the catalogue carries the width next to every program.
 *
 * Shared by the SDK's local gate mirror, the dashboard's create form and the agent page's chips.
 */
import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM, SPL_TOKEN_TAG } from "../tails/solana.ts";

export type DiscriminatorWidth = 1 | 4 | 8;

export interface CatalogueInstruction {
  tag: number;
  /** The identifier the program uses. */
  name: string;
  /** What a judge reads. */
  label: string;
  /** Present when granting it hands the agent more than a payment. */
  risk?: string;
}

export interface CatalogueProgram {
  key: "spl-token" | "spl-token-2022" | "system";
  id: string;
  name: string;
  width: DiscriminatorWidth;
  instructions: CatalogueInstruction[];
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Anchor programs prefix every instruction with sha256("global:<name>")[0..8]. */
export const ANCHOR_DISCRIMINATOR_WIDTH: DiscriminatorWidth = 8;

const SPL_TOKEN_INSTRUCTIONS: CatalogueInstruction[] = [
  { tag: SPL_TOKEN_TAG.transfer, name: "Transfer", label: "Transfer tokens", },
  { tag: SPL_TOKEN_TAG.transferChecked, name: "TransferChecked", label: "Transfer tokens (checked)" },
  { tag: SPL_TOKEN_TAG.approve, name: "Approve", label: "Approve a delegate", risk: "lets the agent delegate your tokens to another key" },
  { tag: SPL_TOKEN_TAG.approveChecked, name: "ApproveChecked", label: "Approve a delegate (checked)", risk: "lets the agent delegate your tokens to another key" },
  { tag: SPL_TOKEN_TAG.revoke, name: "Revoke", label: "Revoke the delegate", risk: "removes any delegate, the mandate's own included" },
  { tag: SPL_TOKEN_TAG.setAuthority, name: "SetAuthority", label: "Set authority", risk: "can hand over ownership of the account" },
  { tag: SPL_TOKEN_TAG.burn, name: "Burn", label: "Burn tokens", risk: "destroys tokens" },
  { tag: SPL_TOKEN_TAG.closeAccount, name: "CloseAccount", label: "Close the account", risk: "closes the account and sends its lamports away" },
];

export const PROGRAM_CATALOGUE: CatalogueProgram[] = [
  { key: "spl-token", id: SPL_TOKEN_PROGRAM, name: "SPL Token", width: 1, instructions: SPL_TOKEN_INSTRUCTIONS },
  { key: "spl-token-2022", id: SPL_TOKEN_2022_PROGRAM, name: "SPL Token-2022", width: 1, instructions: SPL_TOKEN_INSTRUCTIONS },
  {
    key: "system",
    id: SYSTEM_PROGRAM,
    name: "System Program",
    width: 4,
    instructions: [
      { tag: 2, name: "Transfer", label: "Transfer SOL" },
      { tag: 0, name: "CreateAccount", label: "Create an account", risk: "funds a brand-new account from your SOL" },
      { tag: 3, name: "CreateAccountWithSeed", label: "Create an account with seed", risk: "funds a brand-new account from your SOL" },
      { tag: 1, name: "Assign", label: "Assign an account to a program", risk: "changes which program owns an account" },
      { tag: 8, name: "Allocate", label: "Allocate account space" },
      { tag: 11, name: "TransferWithSeed", label: "Transfer SOL with seed" },
    ],
  },
];

export const catalogueProgram = (idOrKey: string): CatalogueProgram | undefined => PROGRAM_CATALOGUE.find((p) => p.key === idOrKey || p.id === idOrKey);

/** The bytes the gate compares, for a tag and a width: one byte, a u32 little-endian, or eight given bytes. */
export function discriminatorBytes(width: DiscriminatorWidth, tag: number | Uint8Array): Uint8Array {
  if (tag instanceof Uint8Array) {
    if (tag.length !== width) throw new RangeError(`a ${width}-byte discriminator needs ${width} bytes, got ${tag.length}`);
    return tag;
  }
  if (!Number.isInteger(tag) || tag < 0) throw new RangeError(`not a tag: ${tag}`);
  if (width === 1) {
    if (tag > 0xff) throw new RangeError(`a 1-byte tag must be 0..255, got ${tag}`);
    return Uint8Array.of(tag);
  }
  if (width === 4) {
    if (tag > 0xffffffff) throw new RangeError(`a u32 tag must fit 32 bits, got ${tag}`);
    return Uint8Array.of(tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff, (tag >>> 24) & 0xff);
  }
  throw new RangeError("an 8-byte (Anchor) discriminator must be given as bytes");
}

/** The on-chain slot: 8 bytes, the discriminator left-aligned, the rest zero. */
export function discriminatorSlot(bytes: Uint8Array): number[] {
  if (bytes.length < 1 || bytes.length > 8) throw new RangeError(`a discriminator is 1..8 bytes, got ${bytes.length}`);
  const slot = new Array<number>(8).fill(0);
  bytes.forEach((b, i) => (slot[i] = b));
  return slot;
}

export const toHex = (bytes: Uint8Array | number[]): string => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** "0x0300000000000000" on SPL Token -> "Transfer (3)". Unknown programs or tags fall back to the bytes. */
export function describeDiscriminator(programId: string, hex: string, width?: DiscriminatorWidth): string {
  const program = catalogueProgram(programId);
  const clean = hex.replace(/^0x/, "");
  const w = width ?? program?.width ?? 8;
  const head = clean.slice(0, w * 2);
  if (program) {
    const tag = w === 1 ? parseInt(head, 16) : w === 4 ? parseInt(head.match(/../g)!.reverse().join(""), 16) : NaN;
    const known = program.instructions.find((i) => i.tag === tag);
    if (known) return `${known.name} (${tag})`;
    if (!Number.isNaN(tag)) return `instruction ${tag}`;
  }
  return `0x${head}`;
}

/** The known instructions of a program that a permission does NOT list: what the agent may not do there. */
export function notPermitted(programId: string, permittedHex: string[], width?: DiscriminatorWidth): CatalogueInstruction[] {
  const program = catalogueProgram(programId);
  if (!program) return [];
  const w = width ?? program.width;
  const permitted = new Set(permittedHex.map((h) => h.replace(/^0x/, "").slice(0, w * 2)));
  return program.instructions.filter((i) => !permitted.has(toHex(discriminatorBytes(w, i.tag)).slice(2)));
}
