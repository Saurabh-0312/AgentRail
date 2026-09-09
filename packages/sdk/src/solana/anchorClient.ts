/**
 * Default `SolanaGateClient` over Anchor + web3.js against the deployed AgentRail program.
 * Reads the zero-copy mandate through the IDL, builds `execute_payment` with the agent as signer,
 * and submits with skipPreflight so a rejection is recorded on chain rather than simulated away.
 */
import anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";

import idl from "./agentrail.idl.json" with { type: "json" };
import type { SolanaGateClient, SolanaMandateState } from "../tails/solana.ts";

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
      const signers = feePayer.publicKey.equals(cfg.agent.publicKey) ? [cfg.agent] : [feePayer, cfg.agent];
      tx.sign(...signers);
      return tx.serialize();
    },

    async send(signedTransaction) {
      const sig = await cfg.connection.sendRawTransaction(signedTransaction, { skipPreflight: true });
      const { blockhash, lastValidBlockHeight } = await cfg.connection.getLatestBlockhash();
      await cfg.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(() => undefined);
      const detail = await cfg.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (detail?.meta?.err) {
        const line = detail.meta.logMessages?.find((l) => l.includes("Error Code")) ?? JSON.stringify(detail.meta.err);
        throw new Error(`execute_payment reverted on chain: ${line} (${sig})`);
      }
      return sig;
    },

    async now() {
      const slot = await cfg.connection.getSlot("confirmed");
      const t = await cfg.connection.getBlockTime(slot);
      return BigInt(t ?? Math.floor(Date.now() / 1000));
    },
  };
}
