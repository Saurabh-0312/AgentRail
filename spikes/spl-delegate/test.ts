import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { approve, createAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import { assert } from "chai";
import { SplDelegate } from "../../target/types/spl_delegate";

describe("spike 1: PDA as SPL token delegate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.splDelegate as Program<SplDelegate>;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;

  it("program signs a transfer as delegate via invoke_signed, and cannot exceed the approved amount", async () => {
    const mint = await createMint(conn, payer, payer.publicKey, null, 6);
    const from = await createAccount(conn, payer, mint, payer.publicKey);
    const to = await createAccount(conn, payer, mint, anchor.web3.Keypair.generate().publicKey);
    await mintTo(conn, payer, mint, from, payer, 1_000_000);

    const [delegate] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("delegate")], program.programId);
    await approve(conn, payer, from, delegate, payer, 500_000);
    assert.equal((await getAccount(conn, from)).delegate?.toBase58(), delegate.toBase58());

    const sig = await program.methods
      .delegateTransfer(new BN(300_000))
      .accountsStrict({ from, to, delegate, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID })
      .rpc();
    console.log("  delegate_transfer tx:", sig);

    assert.equal(Number((await getAccount(conn, to)).amount), 300_000, "to received 300000");
    assert.equal(Number((await getAccount(conn, from)).delegatedAmount), 200_000, "delegated remaining 200000");

    let rejected = false;
    try {
      await program.methods
        .delegateTransfer(new BN(300_000))
        .accountsStrict({ from, to, delegate, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID })
        .rpc();
    } catch {
      rejected = true;
      console.log("  over-delegation correctly rejected on-chain");
    }
    assert.isTrue(rejected, "transfer beyond delegated amount must fail");
  });
});
