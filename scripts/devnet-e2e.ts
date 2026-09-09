/**
 * AgentRail end-to-end on Solana devnet.
 *
 *   owner  -> create_mandate + add_permission(shop, caps) + spl approve(mandate PDA)
 *   agent  -> pay through the SDK's SolanaAdapter (quote -> authorize -> settle)
 *             within caps ................................ lands, USDC moves
 *             over per-tx cap ............................ REFUSED by the adapter's local gate,
 *                                                          then the chain refuses it too (6007)
 *             over lifetime cap .......................... same, on chain 6008
 *
 * Then the part nothing else on Solana can do — INSTRUCTION-LEVEL gating.
 * One permission on the SPL Token program allows exactly one instruction:
 *
 *   agent  -> Transfer     + verify ............... lands   (Transfer is on the list)
 *   agent  -> SetAuthority + verify ............... REVERTS InstructionNotAllowed
 *
 * Same program. Same signer. Same mandate. Different button.
 * `verify` never trusts the caller: it reads the sibling instruction out of the instructions
 * sysvar, so the program id and discriminator are the ones that will actually execute.
 *
 * Payments go through `SolanaAdapter` from @agentrail/sdk, the same interface the agent uses on
 * Hedera and Base. When the adapter refuses, the demo also sends the raw transaction so the chain's
 * own rejection is recorded: two independent gates, same verdict. The verify steps are not
 * payments and stay direct. Rejections are sent with skipPreflight so the chain records them.
 * Output: scripts/out/devnet.json (gitignored) with every signature and address.
 *
 * Run: yarn demo:devnet   (reads SOLANA_RPC_URL and ANCHOR_WALLET from .env)
 */
import anchor from "@coral-xyz/anchor";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  AuthorityType,
  TOKEN_PROGRAM_ID,
  approve,
  createSetAuthorityInstruction,
  createTransferInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AdapterRegistry, CHAINS, MandateRefused, SolanaAdapter, directQuote } from "../packages/sdk/src/index.ts";
import { createAnchorGateClient } from "../packages/sdk/src/solana/anchorClient.ts";
import idl from "../packages/sdk/src/solana/agentrail.idl.json" with { type: "json" };

const { BN, Program, AnchorProvider, Wallet } = anchor;

const DEVNET_USDC = new PublicKey(process.env.DEVNET_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDC = 1_000_000; // 6 decimals
const SPEND_LIMIT = 5 * USDC;
const PER_TX_LIMIT = 2 * USDC;
const MANDATE_HOURS = Number(process.env.MANDATE_HOURS ?? 24);
const ENS_NAME = process.env.RAIL_ENS_NAME ?? "databot.agentrail.eth";

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

function loadOrCreate(file: string): Keypair {
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/** ENS namehash, EIP-137. */
function namehash(name: string): Buffer {
  let node = Buffer.alloc(32);
  for (const label of name.split(".").reverse()) {
    node = Buffer.from(keccak_256(Buffer.concat([node, Buffer.from(keccak_256(Buffer.from(label)))])));
  }
  return node;
}

/** Fetch a landed transaction and report whether the chain rejected it. */
async function landed(conn: Connection, sig: string) {
  let detail = null;
  for (let i = 0; i < 30 && !detail; i++) {
    detail = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!detail) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!detail) throw new Error(`transaction ${sig} never landed`);
  const errLine = detail.meta?.logMessages?.find((l) => l.includes("Error Code")) ?? "";
  return { failed: detail.meta?.err != null, errLine: errLine.replace("Program log: ", "") };
}

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const owner = loadKeypair(expand(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json"));
  const provider = new AnchorProvider(conn, new Wallet(owner), { commitment: "confirmed" });
  const program = new Program(idl as anchor.Idl, provider);
  const methods = program.methods as any;
  const accounts = program.account as any;

  const agent = loadOrCreate("scripts/keys/agent-keypair.json");
  const shop = loadOrCreate("scripts/keys/shop-keypair.json");
  const [mandate, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("mandate"), owner.publicKey.toBuffer(), agent.publicKey.toBuffer()],
    program.programId,
  );

  console.log("program  ", program.programId.toBase58());
  console.log("owner    ", owner.publicKey.toBase58());
  console.log("agent    ", agent.publicKey.toBase58());
  console.log("mandate  ", mandate.toBase58(), "bump", bump);

  const from = await getOrCreateAssociatedTokenAccount(conn, owner, DEVNET_USDC, owner.publicKey);
  const shopAta = await getOrCreateAssociatedTokenAccount(conn, owner, DEVNET_USDC, shop.publicKey);
  const bal = async (pk: PublicKey) => Number((await getAccount(conn, pk)).amount) / USDC;
  console.log("owner USDC", await bal(from.address), " shop USDC", await bal(shopAta.address));

  const txs: Record<string, string> = {};

  // Idempotent: a previous run's mandate is revoked so the demo starts from a clean slate.
  if (await accounts.mandateAccount.fetchNullable(mandate)) {
    txs.revokePrevious = await methods.revokeMandate().accountsStrict({ mandate, owner: owner.publicKey }).rpc();
    console.log("revoked previous mandate", explorer(txs.revokePrevious));
  }

  const ensNode = Array.from(namehash(ENS_NAME));
  const expiry = new BN(Math.floor(Date.now() / 1000) + MANDATE_HOURS * 3600);
  txs.createMandate = await methods
    .createMandate(ensNode, expiry)
    .accountsStrict({ mandate, owner: owner.publicKey, agent: agent.publicKey, systemProgram: anchor.web3.SystemProgram.programId })
    .rpc();
  console.log("create_mandate  ", explorer(txs.createMandate));

  txs.addPermission = await methods
    .addPermission(shopAta.address, [], 1, new BN(SPEND_LIMIT), new BN(PER_TX_LIMIT))
    .accountsStrict({ mandate, owner: owner.publicKey })
    .rpc();
  console.log("add_permission  ", explorer(txs.addPermission));

  // The owner's one-time setup: the mandate PDA becomes the SPL delegate. Allowance is generous on
  // purpose; the mandate, not the allowance, is what limits the agent.
  txs.approve = await approve(conn, owner, from.address, mandate, owner, 100 * USDC);
  console.log("spl approve     ", explorer(txs.approve));

  // ---------------------------------------------------------------------------
  // Payments through the SDK: the same PaymentAdapter interface as Hedera and Base.
  // ---------------------------------------------------------------------------
  const gateClient = createAnchorGateClient({ connection: conn, agent, feePayer: owner, ownerTokenAccount: from.address });
  const registry = new AdapterRegistry().register(CHAINS.SOLANA_DEVNET, () => new SolanaAdapter({ agent: agent.publicKey.toBase58(), client: gateClient }));
  const adapter = registry.select("solana:devnet"); // the string ENS rail.chain will carry
  const mandateRef = { chain: CHAINS.SOLANA_DEVNET, id: mandate.toBase58() };
  console.log("\n--- payments via SolanaAdapter (", adapter.chain, ") ---");

  const pay = async (amount: number, label: string, expectOk: boolean) => {
    const quote = directQuote({ chain: CHAINS.SOLANA_DEVNET, resource: "agentrail://shop/devnet-demo", amount: BigInt(amount), asset: DEVNET_USDC.toBase58(), payTo: shop.publicKey.toBase58() });
    try {
      const auth = await adapter.authorize(mandateRef, quote);
      const done = await adapter.settle(auth);
      console.log(`${label.padEnd(24)} landed   ${done.explorer}`);
      if (!expectOk) throw new Error(`${label}: expected a refusal`);
      return done.transactionId;
    } catch (e) {
      if (!(e instanceof MandateRefused)) throw e;
      console.log(`${label.padEnd(24)} REFUSED by SolanaAdapter: ${e.reason} (no transaction built)`);
      if (expectOk) throw new Error(`${label}: expected success`);
      // Second gate, same verdict: send the raw transaction anyway so the chain's own rejection is on record.
      const raw = await gateClient.buildExecutePayment(mandate.toBase58(), shopAta.address.toBase58(), BigInt(amount));
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: true });
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(() => undefined);
      const r = await landed(conn, sig);
      console.log(`${"".padEnd(24)} ${r.failed ? "REVERTED" : "landed  "} on chain ${explorer(sig)}`);
      if (r.errLine) console.log(" ".repeat(25) + r.errLine);
      if (!r.failed) throw new Error(`${label}: chain accepted what the adapter refused`);
      return sig;
    }
  };

  txs.payWithinCap = await pay(1.5 * USDC, "pay 1.5 USDC", true);
  txs.payOverPerTx = await pay(2.5 * USDC, "pay 2.5 USDC (>per-tx)", false);
  txs.paySecond = await pay(1.5 * USDC, "pay 1.5 USDC", true);
  txs.payThird = await pay(1.5 * USDC, "pay 1.5 USDC", true);
  txs.payOverLifetime = await pay(1 * USDC, "pay 1.0 USDC (>lifetime)", false);

  // ---------------------------------------------------------------------------
  // Instruction-level gating. Everything above is a spend limit; this is the part
  // no other Solana protocol can express: one program, one allowed instruction.
  // ---------------------------------------------------------------------------
  console.log("\n--- instruction-level gating (verify) ---");

  // A discriminator slot is 8 bytes wide; only the first `size` bytes are compared.
  // Matches `disc` in tests/helpers.ts: a narrow tag, zero-padded to the 8-byte slot.
  const disc = (...prefix: number[]) => Array.from(Buffer.alloc(8).fill(0).map((_, i) => prefix[i] ?? 0));
  const SPL_TRANSFER = disc(3); // SPL Token tag 3 = Transfer
  const SPL_SETAUTHORITY_TAG = 6; // tag 6 = SetAuthority — deliberately NOT listed

  // Permission #1 is keyed by the SPL Token program and lists exactly one instruction.
  txs.addTokenPermission = await methods
    .addPermission(TOKEN_PROGRAM_ID, [SPL_TRANSFER], 1, new BN(2 * USDC), new BN(1 * USDC))
    .accountsStrict({ mandate, owner: owner.publicKey })
    .rpc();
  console.log("add_permission(SPL Token: Transfer only)", explorer(txs.addTokenPermission));

  const verifyIx = (targetIndex: number, amount: number) =>
    methods
      .verify(targetIndex, new BN(amount))
      .accountsStrict({ mandate, agent: agent.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();

  // Same send-and-report path as before: skipPreflight so the chain records the rejection.
  const land = async (ixs: TransactionInstruction[], label: string, expectOk: boolean) => {
    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner.publicKey;
    tx.sign(owner, agent);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(() => undefined);
    const r = await landed(conn, sig);
    console.log(`${label.padEnd(34)} ${r.failed ? "REVERTED" : "landed  "} ${explorer(sig)}`);
    if (r.errLine) console.log(" ".repeat(35) + r.errLine);
    if (r.failed === expectOk) throw new Error(`${label}: expected ${expectOk ? "success" : "revert"}`);
    return sig;
  };

  // ALLOWED: Transfer is on the list. [target, verify] — the index can point backwards.
  txs.verifyTransferAllowed = await land(
    [
      createTransferInstruction(from.address, shopAta.address, owner.publicKey, 0.5 * USDC),
      await verifyIx(0, 0.5 * USDC),
    ],
    "Transfer      + verify",
    true,
  );

  // DENIED: the agent tries to seize the owner's token account. Same program, same signer,
  // same mandate — but SetAuthority is not on the list. `verify` runs first so the sibling
  // never executes; a revert would unwind it anyway, since Solana transactions are atomic.
  txs.verifySetAuthorityDenied = await land(
    [
      await verifyIx(1, 0),
      createSetAuthorityInstruction(from.address, owner.publicKey, AuthorityType.AccountOwner, agent.publicKey),
    ],
    "SetAuthority  + verify",
    false,
  );
  console.log(`(SPL Token tag ${SPL_SETAUTHORITY_TAG} is absent from the mandate — the discriminator gate rejects it)`);

  const m = await accounts.mandateAccount.fetch(mandate);
  const p = m.permissions[0];
  const t = m.permissions[1];
  console.log("\nshop USDC", await bal(shopAta.address));
  console.log("  payments  (destination-keyed) spend_total", Number(p.spendTotal) / USDC, " call_count", p.callCount);
  console.log("  SPL Token (instruction-keyed) spend_total", Number(t.spendTotal) / USDC, " call_count", t.callCount);

  const out = {
    cluster: "devnet",
    programId: program.programId.toBase58(),
    owner: owner.publicKey.toBase58(),
    agent: agent.publicKey.toBase58(),
    mandate: mandate.toBase58(),
    ownerTokenAccount: from.address.toBase58(),
    shopTokenAccount: shopAta.address.toBase58(),
    ensName: ENS_NAME,
    ensNode: "0x" + Buffer.from(ensNode).toString("hex"),
    expiry: expiry.toNumber(),
    caps: { spendLimit: SPEND_LIMIT, perTxLimit: PER_TX_LIMIT },
    paymentsVia: "@agentrail/sdk SolanaAdapter",
    txs,
    explorer: Object.fromEntries(Object.entries(txs).map(([k, v]) => [k, explorer(v)])),
  };
  fs.mkdirSync("scripts/out", { recursive: true });
  fs.writeFileSync("scripts/out/devnet.json", JSON.stringify(out, null, 2));
  console.log("\nwrote scripts/out/devnet.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
