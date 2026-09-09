import * as anchor from "@coral-xyz/anchor";
import { AnchorError, BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { Agentrail } from "../target/types/agentrail";
import idl from "../target/idl/agentrail.json";

export const MANDATE_SEED = Buffer.from("mandate");
export const MAX_PERMISSIONS = 16;

export const nowSec = () => Math.floor(Date.now() / 1000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const bytes32 = (fill: number) => Array.from(Buffer.alloc(32, fill));
export const disc8 = (fill: number) => Array.from(Buffer.alloc(8, fill));
/// A discriminator narrower than 8 bytes, zero-padded to the 8-byte slot.
export const disc = (...prefix: number[]) => {
  const b = Buffer.alloc(8);
  Buffer.from(prefix).copy(b);
  return Array.from(b);
};
export const sameKey = (raw: number[], pk: PublicKey) => Buffer.from(raw).equals(pk.toBuffer());
export const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export function setup() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as Agentrail, provider);
  return { provider, program, owner: provider.wallet.publicKey };
}

export function mandatePda(program: Program<Agentrail>, owner: PublicKey, agent: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [MANDATE_SEED, owner.toBuffer(), agent.toBuffer()],
    program.programId,
  );
}

export async function createMandate(
  program: Program<Agentrail>,
  owner: PublicKey,
  agent: Keypair,
  ensNode: number[],
  expiry: BN,
) {
  const [mandate] = mandatePda(program, owner, agent.publicKey);
  await program.methods
    .createMandate(ensNode, expiry)
    .accountsStrict({ mandate, owner, agent: agent.publicKey, systemProgram: SystemProgram.programId })
    .rpc();
  return mandate;
}

/// Anchor errors thrown by `.rpc()` arrive as AnchorError; those thrown by
/// `provider.sendAndConfirm` arrive as SendTransactionError carrying the logs.
function toAnchorError(e: unknown): AnchorError | null {
  if (e instanceof AnchorError) return e;
  const logs = (e as { logs?: string[]; transactionLogs?: string[] })?.logs
    ?? (e as { transactionLogs?: string[] })?.transactionLogs;
  return logs ? AnchorError.parse(logs) : null;
}

export async function expectAnchorError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const ae = toAnchorError(e);
    if (ae) {
      assert.equal(ae.error.errorCode.code, code, `expected ${code}, got ${ae.error.errorCode.code}`);
      return;
    }
    throw new Error(`expected AnchorError ${code}, got: ${e}`);
  }
  throw new Error(`expected ${code}, transaction succeeded`);
}

export async function expectReject(p: Promise<unknown>, needle: string) {
  try {
    await p;
  } catch (e) {
    assert.include(String(e), needle);
    return;
  }
  throw new Error(`expected rejection containing "${needle}", transaction succeeded`);
}
