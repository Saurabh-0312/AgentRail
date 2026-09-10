/**
 * Default `SolanaGateClient` over Anchor + web3.js against the deployed AgentRail program.
 * Reads the zero-copy mandate through the IDL, builds `execute_payment` with the agent as signer,
 * and submits with skipPreflight so a rejection is recorded on chain rather than simulated away.
 */
import anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";

import idl from "./agentrail.idl.json" with { type: "json" };
import type { LandedTransaction, SolanaGateClient, SolanaMandateState } from "../tails/solana.ts";

const { BN, Program, AnchorProvider, Wallet } = anchor;

export interface AnchorGateClientConfig {
  connection: Connection;
  /** Signs `execute_payment`. Holds no tokens; only the mandate PDA moves value. */
  agent: Keypair;
  /** Pays the transaction fee. Defaults to the agent. */
  feePayer?: Keypair;
  /** The owner's token account the mandate PDA is delegate on. */
  ownerTokenAccount: PublicKey;
}

export function createAnchorGateClient(cfg: AnchorGateClientConfig): SolanaGateClient {
  const provider = new AnchorProvider(cfg.connection, new Wallet(cfg.agent), { commitment: "confirmed" });
  const program = new Program(idl as anchor.Idl, provider);
  const feePayer = cfg.feePayer ?? cfg.agent;
  const signers = () => (feePayer.publicKey.equals(cfg.agent.publicKey) ? [cfg.agent] : [feePayer, cfg.agent]);

  /** Submit with skipPreflight and read the landed transaction back: the chain's verdict, signature included. */
  const land = async (signedTransaction: Uint8Array): Promise<LandedTransaction> => {
    const signature = await cfg.connection.sendRawTransaction(signedTransaction, { skipPreflight: true });
    const { blockhash, lastValidBlockHeight } = await cfg.connection.getLatestBlockhash();
    await cfg.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed").catch(() => undefined);
    let detail = null;
    for (let i = 0; i < 30 && !detail; i++) {
      detail = await cfg.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!detail) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!detail) throw new Error(`transaction ${signature} never landed`);
    const failed = detail.meta?.err != null;
    const line = detail.meta?.logMessages?.find((l) => l.includes("Error Code")) ?? (failed ? JSON.stringify(detail.meta?.err) : "");
    const errorLine = line.replace("Program log: ", "");
    const code = errorLine.match(/Error Number: (\d+)/)?.[1];
    const name = errorLine.match(/Error Code: (\w+)/)?.[1];
    return { signature, failed, errorLine, errorCode: code ? Number(code) : null, errorName: name ?? null };
  };

  return {
    async readMandate(mandate) {
      const m = (await (program.account as any).mandateAccount.fetchNullable(new PublicKey(mandate))) as any;
      if (!m) return null;
      const len = Number(m.permissionsLen);
      const state: SolanaMandateState = {
        active: m.active === 1,
        expiry: BigInt(m.expiry.toString()),
        agent: new PublicKey(m.agent).toBase58(),
        permissions: (m.permissions as any[]).slice(0, len).map((p) => ({
          key: new PublicKey(p.programId).toBase58(),
          spendLimit: BigInt(p.spendLimit.toString()),
          perTxLimit: BigInt(p.perTxLimit.toString()),
          spendTotal: BigInt(p.spendTotal.toString()),
          discriminators: (p.discriminators as number[][]).slice(0, Number(p.discriminatorsLen)).map((d) => "0x" + Buffer.from(d).toString("hex")),
          discriminatorSize: Number(p.discriminatorSize),
        })),
      };
      return state;
    },

    async destinationTokenAccount(payTo, asset) {
      return getAssociatedTokenAddressSync(new PublicKey(asset), new PublicKey(payTo), true).toBase58();
    },

    async buildExecutePayment(mandate, destination, amount) {
      const tx: Transaction = await (program.methods as any)
        .executePayment(new BN(amount.toString()))
        .accountsStrict({
          mandate: new PublicKey(mandate),
          agent: cfg.agent.publicKey,
          from: cfg.ownerTokenAccount,
          destination: new PublicKey(destination),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .transaction();
      const { blockhash } = await cfg.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = feePayer.publicKey;
      tx.sign(...signers());
      return tx.serialize();
    },

    async buildVerifiedInstruction(mandate, sibling, declaredAmount) {
      const verifyIx = await (program.methods as any)
        .verify(1, new BN(declaredAmount.toString()))
        .accountsStrict({ mandate: new PublicKey(mandate), agent: cfg.agent.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
        .instruction();
      const target = new TransactionInstruction({
        programId: new PublicKey(sibling.programId),
        keys: sibling.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(sibling.data),
      });
      // verify runs first, so a refusal stops the transaction before the sibling executes; a later
      // revert would unwind it anyway, since the transaction is atomic. The sibling's own authority
      // must be the fee payer or the agent: those are the only keys that sign here.
      const tx = new Transaction().add(verifyIx, target);
      const { blockhash } = await cfg.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = feePayer.publicKey;
      tx.sign(...signers());
      return tx.serialize();
    },

    land,

    async send(signedTransaction) {
      const r = await land(signedTransaction);
      if (r.failed) throw new Error(`transaction reverted on chain: ${r.errorLine} (${r.signature})`);
      return r.signature;
    },

    async now() {
      const slot = await cfg.connection.getSlot("confirmed");
      const t = await cfg.connection.getBlockTime(slot);
      return BigInt(t ?? Math.floor(Date.now() / 1000));
    },
  };
}
