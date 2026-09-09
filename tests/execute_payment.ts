import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  approve,
  createAccount,
  createMint,
  createTransferInstruction,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { bytes32, createMandate, expectAnchorError, expectReject, nowSec, setup, sleep } from "./helpers";

// The gate. The owner's tokens stay in the owner's account; the mandate PDA is the SPL delegate.
// Every rejection is the chain refusing, not the client.

describe("execute_payment", () => {
  const { provider, program, owner } = setup();
  const payer = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;

  const agent = Keypair.generate();
  const intruder = Keypair.generate();
  let mint: PublicKey;
  let from: PublicKey;
  let shop: PublicKey; // allowed destination
  let attacker: PublicKey; // never allowed
  let mandate: PublicKey;

  const SPEND_LIMIT = 250_000;
  const PER_TX_LIMIT = 100_000;
  const DELEGATED = 1_000_000; // SPL allowance is deliberately above the mandate caps

  const pay = (destination: PublicKey, amount: number, signer: Keypair = agent, account: PublicKey = mandate) =>
    program.methods
      .executePayment(new BN(amount))
      .accountsStrict({ mandate: account, agent: signer.publicKey, from, destination, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([signer])
      .rpc();

  const balance = async (acct: PublicKey) => Number((await getAccount(conn, acct)).amount);
  const permission = async (idx: number) => (await program.account.mandateAccount.fetch(mandate)).permissions[idx];

  before(async () => {
    mint = await createMint(conn, payer, owner, null, 6);
    from = await createAccount(conn, payer, mint, owner);
    shop = await createAccount(conn, payer, mint, Keypair.generate().publicKey);
    attacker = await createAccount(conn, payer, mint, Keypair.generate().publicKey);
    await mintTo(conn, payer, mint, from, payer, 5_000_000);

    mandate = await createMandate(program, owner, agent, bytes32(0x77), new BN(nowSec() + 3600));
    await program.methods
      .addPermission(shop, [], 1, new BN(SPEND_LIMIT), new BN(PER_TX_LIMIT))
      .accountsStrict({ mandate, owner })
      .rpc();

    // The one-time setup the owner does: delegate to the mandate PDA. No key is handed to the agent.
    await approve(conn, payer, from, mandate, payer, DELEGATED);
    const acct = await getAccount(conn, from);
    assert.equal(acct.delegate?.toBase58(), mandate.toBase58());
    assert.equal(Number(acct.delegatedAmount), DELEGATED);
  });

  it("agent cannot transfer directly: it holds no authority", async () => {
    const ix = createTransferInstruction(from, shop, agent.publicKey, 1);
    await expectReject(provider.sendAndConfirm(new Transaction().add(ix), [agent]), "owner does not match");
    assert.equal(await balance(shop), 0);
  });

  it("pays within the caps and the balances move", async () => {
    const before = await balance(from);
    await pay(shop, 60_000);
    assert.equal(await balance(shop), 60_000);
    assert.equal(await balance(from), before - 60_000);

    const p = await permission(0);
    assert.isTrue((p.spendTotal as BN).eqn(60_000));
    assert.equal(p.callCount, 1);
    assert.equal(Number((await getAccount(conn, from)).delegatedAmount), DELEGATED - 60_000);
  });

  it("rejects a destination that is not on the allowed list", async () => {
    await expectAnchorError(pay(attacker, 1), "DestinationNotAllowed");
    assert.equal(await balance(attacker), 0);
  });

  it("rejects a signer who is not the mandated agent", async () => {
    await expectAnchorError(pay(shop, 1, intruder), "NotTheAgent");
  });

  it("rejects an amount over the per-transaction cap", async () => {
    await expectAnchorError(pay(shop, PER_TX_LIMIT + 1), "PerTxLimitExceeded");
    assert.equal(await balance(shop), 60_000, "nothing moved");
  });

  it("rejects an amount that would breach the lifetime cap", async () => {
    // 60_000 spent, 250_000 lifetime: 100_000 + 100_000 fits, the third does not.
    await pay(shop, 100_000);
    await expectAnchorError(pay(shop, 100_000), "SpendLimitExceeded");
    await pay(shop, 90_000);
    assert.equal(await balance(shop), 250_000);
    assert.isTrue(((await permission(0)).spendTotal as BN).eqn(SPEND_LIMIT));
    await expectAnchorError(pay(shop, 1), "SpendLimitExceeded");
  });

  it("does not record a spend when the transfer itself fails", async () => {
    // Fresh mandate with caps above the SPL allowance: the mandate passes, the token program refuses.
    const bigAgent = Keypair.generate();
    const big = await createMandate(program, owner, bigAgent, bytes32(0x78), new BN(nowSec() + 3600));
    await program.methods.addPermission(shop, [], 1, new BN(0), new BN(0)).accountsStrict({ mandate: big, owner }).rpc();
    await approve(conn, payer, from, big, payer, 10);

    await expectReject(pay(shop, 11, bigAgent, big), "insufficient funds");
    const p = (await program.account.mandateAccount.fetch(big)).permissions[0];
    assert.isTrue((p.spendTotal as BN).isZero());
    assert.equal(p.callCount, 0);

    // Restore the delegation for the main mandate; SPL keeps a single delegate per account.
    await approve(conn, payer, from, mandate, payer, DELEGATED);
  });

  it("rejects a token account the mandate owner does not own", async () => {
    const stranger = Keypair.generate();
    const strangerAcct = await createAccount(conn, payer, mint, stranger.publicKey);
    await expectAnchorError(
      program.methods
        .executePayment(new BN(1))
        .accountsStrict({ mandate, agent: agent.publicKey, from: strangerAcct, destination: shop, tokenProgram: TOKEN_PROGRAM_ID })
        .signers([agent])
        .rpc(),
      "TokenAccountNotOwned",
    );
  });

  it("rejects once the mandate has expired", async () => {
    const shortAgent = Keypair.generate();
    const short = await createMandate(program, owner, shortAgent, bytes32(0x79), new BN(nowSec() + 3));
    await program.methods.addPermission(shop, [], 1, new BN(0), new BN(0)).accountsStrict({ mandate: short, owner }).rpc();
    await approve(conn, payer, from, short, payer, DELEGATED);
    await sleep(5000);
    await expectAnchorError(pay(shop, 1, shortAgent, short), "Expired");
    await approve(conn, payer, from, mandate, payer, DELEGATED);
  });

  it("rejects after the owner revokes the mandate, even though the SPL delegation still points at it", async () => {
    await program.methods.revokeMandate().accountsStrict({ mandate, owner }).rpc();
    assert.equal((await getAccount(conn, from)).delegate?.toBase58(), mandate.toBase58(), "delegation untouched");
    await expectAnchorError(pay(shop, 1), "AccountOwnedByWrongProgram");
    assert.equal(await balance(shop), 250_000, "nothing moved");
  });
});
