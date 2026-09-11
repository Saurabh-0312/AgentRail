/**
 * The Solana create form, as pure functions: what the owner is about to sign, validated before
 * anything is built. The on-chain layout is fixed (SPEC §8.2): 16 permissions per mandate, 8
 * discriminators per permission, one width per permission; the form refuses to build a
 * transaction that the program would refuse.
 */
import { PROGRAM_CATALOGUE, catalogueProgram, discriminatorBytes, discriminatorSlot, toHex, type DiscriminatorWidth } from "@agentrail/sdk/src/solana/catalogue.ts";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { namehash } from "viem/ens";

import { ERROR_NAMES, ERROR_REASONS } from "./chains";

export const MAX_PERMISSIONS = 16;
export const MAX_DISCRIMINATORS = 8;
export const AGENTRAIL_PROGRAM = "GcYqRmrRko3WbKNuGarDTbmRF1GcdeHzc3eV37gtM4Bj";

/** A permission the owner is composing. Programs are gated by instruction; payments by destination token account. */
export type PermissionDraft =
  | {
      id: string;
      kind: "program";
      /** A catalogue key, or "custom" with programId/width/customHex filled in. */
      program: string;
      programId: string;
      width: DiscriminatorWidth;
      /** Catalogue tags ticked. */
      tags: number[];
      /** Advanced: raw discriminators as hex, one per entry, each exactly `width` bytes. */
      customHex: string[];
      perTx: string;
      total: string;
    }
  | {
      id: string;
      kind: "payment";
      /** The destination token account `execute_payment` may pay. */
      destination: string;
      perTx: string;
      total: string;
    };

export interface SolanaCreateDraft {
  agent: string;
  ensName: string;
  days: number;
  permissions: PermissionDraft[];
  /** Step 3: base units of the mint the owner's token account holds, delegated to the PDA. */
  approveAmount: string;
}

export const isPubkey = (s: string): boolean => {
  try {
    new PublicKey(s.trim());
    return s.trim().length >= 32;
  } catch {
    return false;
  }
};

const isUnits = (s: string) => /^\d+$/.test(s.trim());

export function programPermission(program = "spl-token"): PermissionDraft {
  const p = catalogueProgram(program);
  return { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: "program", program, programId: p?.id ?? "", width: p?.width ?? 8, tags: p ? [p.instructions[0].tag] : [], customHex: [], perTx: "1000000", total: "2000000" };
}

export function paymentPermission(): PermissionDraft {
  return { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: "payment", destination: "", perTx: "2000000", total: "5000000" };
}

export function defaultDraft(ensName: string): SolanaCreateDraft {
  const program = programPermission("spl-token");
  const payment = paymentPermission();
  return { agent: "", ensName, days: 30, permissions: [program, payment], approveAmount: String(BigInt(program.total) + BigInt(payment.total)) };
}

/** Every discriminator a program permission will store, as hex, in the order the program will hold them. */
export function permissionDiscriminators(p: Extract<PermissionDraft, { kind: "program" }>): string[] {
  const out: string[] = [];
  for (const tag of p.tags) out.push(toHex(discriminatorBytes(p.width, tag)));
  for (const raw of p.customHex) {
    const clean = raw.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== p.width * 2) throw new RangeError(`a custom discriminator must be exactly ${p.width} bytes of hex, got "${raw}"`);
    out.push(`0x${clean.toLowerCase()}`);
  }
  return out;
}

export interface Validation {
  ok: boolean;
  errors: string[];
}

export function validateDraft(d: SolanaCreateDraft): Validation {
  const errors: string[] = [];
  if (!isPubkey(d.agent)) errors.push("agent address must be a base58 public key");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d.ensName.trim().toLowerCase())) errors.push("ENS name must look like a name (its namehash becomes ens_node)");
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > 365) errors.push("expiry must be 1..365 days");
  if (d.permissions.length === 0) errors.push("add at least one permission");
  if (d.permissions.length > MAX_PERMISSIONS) errors.push(`a mandate holds at most ${MAX_PERMISSIONS} permissions (the on-chain layout is fixed); remove ${d.permissions.length - MAX_PERMISSIONS}`);
  const keys = new Set<string>();
  d.permissions.forEach((p, i) => {
    const n = i + 1;
    if (!isUnits(p.perTx) || !isUnits(p.total)) errors.push(`permission ${n}: caps must be whole base units`);
    else if (BigInt(p.total) !== 0n && BigInt(p.perTx) > BigInt(p.total)) errors.push(`permission ${n}: per-transaction cap exceeds the lifetime cap`);
    if (p.kind === "payment") {
      if (!isPubkey(p.destination)) errors.push(`permission ${n}: destination must be a token account (base58)`);
      else if (keys.has(p.destination.trim())) errors.push(`permission ${n}: ${p.destination.trim().slice(0, 8)}… is already listed (the program refuses DuplicatePermission)`);
      keys.add(p.destination.trim());
      return;
    }
    if (!isPubkey(p.programId)) errors.push(`permission ${n}: program id must be a base58 public key`);
    else if (keys.has(p.programId.trim())) errors.push(`permission ${n}: program ${p.programId.trim().slice(0, 8)}… is already listed (the program refuses DuplicatePermission)`);
    keys.add(p.programId.trim());
    if (![1, 4, 8].includes(p.width)) errors.push(`permission ${n}: discriminator width must be 1, 4 or 8`);
    let count = 0;
    try {
      count = permissionDiscriminators(p).length;
    } catch (e) {
      errors.push(`permission ${n}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (count === 0) errors.push(`permission ${n}: pick at least one instruction, or the permission allows nothing`);
    if (count > MAX_DISCRIMINATORS) errors.push(`permission ${n}: at most ${MAX_DISCRIMINATORS} instructions per program (the on-chain layout is fixed); you picked ${count}`);
  });
  if (!isUnits(d.approveAmount)) errors.push("the delegation amount must be whole base units");
  return { ok: errors.length === 0, errors };
}

/** The account being created: `[b"mandate", owner, agent]` under the AgentRail program. */
export function derivePda(owner: string, agent: string, programId = AGENTRAIL_PROGRAM): string {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("mandate"), new PublicKey(owner).toBuffer(), new PublicKey(agent).toBuffer()], new PublicKey(programId));
  return pda.toBase58();
}

/** The join key the whole proof layer depends on: the ENS namehash written as `ens_node`. */
export const ensNodeOf = (name: string): `0x${string}` => namehash(name.trim().toLowerCase());

export const ensNodeBytes = (name: string): number[] => Array.from(Buffer.from(ensNodeOf(name).slice(2), "hex"));

export interface AddPermissionArgs {
  key: string;
  discriminators: number[][];
  size: number;
  spendLimit: bigint;
  perTxLimit: bigint;
  /** For the log and the result panel. */
  label: string;
}

/** What `add_permission` receives for one draft entry. */
export function toAddPermissionArgs(p: PermissionDraft): AddPermissionArgs {
  if (p.kind === "payment") {
    return { key: p.destination.trim(), discriminators: [], size: 1, spendLimit: BigInt(p.total), perTxLimit: BigInt(p.perTx), label: `pay ${p.destination.trim().slice(0, 8)}…` };
  }
  const hexes = permissionDiscriminators(p);
  const program = catalogueProgram(p.programId) ?? catalogueProgram(p.program);
  return {
    key: p.programId.trim(),
    discriminators: hexes.map((h) => discriminatorSlot(Uint8Array.from(Buffer.from(h.slice(2), "hex")))),
    size: p.width,
    spendLimit: BigInt(p.total),
    perTxLimit: BigInt(p.perTx),
    label: `${program?.name ?? p.programId.trim().slice(0, 8) + "…"}: ${hexes.length} instruction${hexes.length === 1 ? "" : "s"}`,
  };
}

/** The lifetime caps summed: what step 3 delegates by default, so the mandate can pay everything it permits. */
export function totalLifetime(perms: PermissionDraft[]): string {
  let sum = 0n;
  for (const p of perms) if (isUnits(p.total)) sum += BigInt(p.total);
  return sum.toString();
}

/** Anchor errors carry the program's code; surface it as the SPEC names it. */
export function solanaErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const anchor = e as { error?: { errorCode?: { number?: number; code?: string }; errorMessage?: string } };
  const code = anchor?.error?.errorCode?.number ?? Number((msg.match(/Error Number: (\d+)/) ?? msg.match(/custom program error: 0x([0-9a-f]+)/i)?.map((h, i) => (i === 1 ? String(parseInt(h, 16)) : h)) ?? [])[1]);
  if (code && ERROR_NAMES[code]) return `${code} ${ERROR_NAMES[code]}${ERROR_REASONS[code] ? `: ${ERROR_REASONS[code]}` : ""}`;
  return msg.split("\n")[0].slice(0, 200);
}

export const PROGRAM_CHOICES = PROGRAM_CATALOGUE.map((p) => ({ key: p.key, name: p.name, id: p.id, width: p.width }));
