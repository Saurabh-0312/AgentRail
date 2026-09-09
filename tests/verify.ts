import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import {
  bytes32,
  createMandate,
  disc,
  expectAnchorError,
  nowSec,
  setup,
  sleep,
  u64le,
} from "./helpers";

// `verify` reads the sibling instruction from the instructions sysvar. The agent never names a
// program, an instruction or (for SPL Token) an amount; it can only point at an index.
// Deny tests place `verify` first so its error surfaces before the sibling would even run.

const SYSTEM_TRANSFER = disc(2, 0, 0, 0); // u32 LE tag, 4-byte width
const SPL_TRANSFER = disc(3); // 1-byte tag

describe("verify", () => {
  const { provider, program, owner } = setup();
  const agent = Keypair.generate();
  const intruder = Keypair.generate();
  let mandate: PublicKey;

  const verifyIx = (targetIndex: number, amount: number, signer: Keypair = agent) =>
    program.methods
      .verify(targetIndex, new BN(amount))
      .accountsStrict({ mandate, agent: signer.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();

  const lamportTransfer = (lamports: number) =>
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent.publicKey, lamports });

  /// [verify, target]: target index is 1.
  const send = async (target: TransactionInstruction, amount: number, signer: Keypair = agent, extra: Keypair[] = []) => {
    const tx = new Transaction().add(await verifyIx(1, amount, signer)).add(target);
    return provider.sendAndConfirm(tx, [signer, ...extra]);
  };

  const permission = async (idx: number) => (await program.account.mandateAccount.fetch(mandate)).permissions[idx];

  before(async () => {
    // The agent receives the test transfers; it must already be rent-exempt.
    await provider.sendAndConfirm(new Transaction().add(lamportTransfer(1_000_000_000)));
    mandate = await createMandate(program, owner, agent, bytes32(0xcd), new BN(nowSec() + 3600));
    await program.methods
      .addPermission(SystemProgram.programId, [SYSTEM_TRANSFER], 4, new BN(2500), new BN(2000))
      .accountsStrict({ mandate, owner })
      .rpc();
  });

  it("allows a permitted instruction and records the spend", async () => {
    // [target, verify]: proves the index can point backwards too.
    const tx = new Transaction().add(lamportTransfer(1000)).add(await verifyIx(0, 1000));
    await provider.sendAndConfirm(tx, [agent]);

    const p = await permission(0);
    assert.isTrue((p.spendTotal as BN).eqn(1000));
    assert.equal(p.callCount, 1);
  });

  it("rejects a signer who is not the mandated agent", async () => {
    await expectAnchorError(send(lamportTransfer(1), 1, intruder), "NotTheAgent");
  });

  it("rejects a sibling from a program the mandate does not list", async () => {
    const tokenIx = new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [], data: Buffer.from([17]) });
    await expectAnchorError(send(tokenIx, 1), "ProgramNotAllowed");
  });

  it("rejects a sibling whose discriminator is not listed, even from a permitted program", async () => {
    const victim = Keypair.generate();
    const assign = SystemProgram.assign({ accountPubkey: victim.publicKey, programId: TOKEN_PROGRAM_ID });
    await expectAnchorError(send(assign, 1, agent, [victim]), "InstructionNotAllowed");
  });

  it("rejects an amount above the per-transaction limit", async () => {
    await expectAnchorError(send(lamportTransfer(2001), 2001), "PerTxLimitExceeded");
  });

  it("rejects an amount that would breach the lifetime limit", async () => {
    // 1000 already spent; 1000 + 2000 > 2500.
    await expectAnchorError(send(lamportTransfer(2000), 2000), "SpendLimitExceeded");
  });

  it("allows spending exactly up to the lifetime limit", async () => {
    await send(lamportTransfer(1500), 1500);
    const p = await permission(0);
    assert.isTrue((p.spendTotal as BN).eqn(2500));
    assert.equal(p.callCount, 2);
  });

  it("rejects a target index that points at AgentRail itself", async () => {
    const tx = new Transaction().add(await verifyIx(0, 1)).add(lamportTransfer(1));
    await expectAnchorError(provider.sendAndConfirm(tx, [agent]), "InvalidTargetInstruction");
  });

  it("rejects a target index outside the transaction", async () => {
    const tx = new Transaction().add(await verifyIx(7, 1)).add(lamportTransfer(1));
    await expectAnchorError(provider.sendAndConfirm(tx, [agent]), "InvalidTargetInstruction");
  });

  describe("SPL Token amount binding", () => {
    before(async () => {
      await program.methods
        .addPermission(TOKEN_PROGRAM_ID, [SPL_TRANSFER], 1, new BN(0), new BN(2000))
        .accountsStrict({ mandate, owner })
        .rpc();
    });

    it("uses the amount inside the real Transfer instruction, not the declared one", async () => {
      // Real instruction moves 5000; the agent declares 1. The mandate must see 5000.
      const transfer = new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [],
        data: Buffer.concat([Buffer.from([3]), u64le(5000)]),
      });
      await expectAnchorError(send(transfer, 1), "PerTxLimitExceeded");
    });
  });

  describe("expiry", () => {
    it("rejects once the mandate has expired", async () => {
      const shortAgent = Keypair.generate();
      const shortMandate = await createMandate(program, owner, shortAgent, bytes32(0xef), new BN(nowSec() + 3));
      await program.methods
        .addPermission(SystemProgram.programId, [SYSTEM_TRANSFER], 4, new BN(0), new BN(0))
        .accountsStrict({ mandate: shortMandate, owner })
        .rpc();
      await sleep(5000);

      const ix = await program.methods
        .verify(1, new BN(1))
        .accountsStrict({ mandate: shortMandate, agent: shortAgent.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
        .instruction();
      const tx = new Transaction().add(ix).add(lamportTransfer(1));
      await expectAnchorError(provider.sendAndConfirm(tx, [shortAgent]), "Expired");
    });
  });
});
