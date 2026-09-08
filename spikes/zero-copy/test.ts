import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { ZeroCopyCheck } from "../../target/types/zero_copy_check";

describe("spike 2: #[account(zero_copy)] mandate layout", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.zeroCopyCheck as Program<ZeroCopyCheck>;

  it("initialises via AccountLoader, account is exactly 2176 bytes, fields round-trip", async () => {
    const owner = provider.wallet.publicKey;
    const [mandate] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), owner.toBuffer()],
      program.programId
    );
    const expiry = new BN(Math.floor(Date.now() / 1000) + 3600);

    const sig = await program.methods
      .initMandate(expiry)
      .accountsStrict({ mandate, owner, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    console.log("  init_mandate tx:", sig);

    const info = await provider.connection.getAccountInfo(mandate);
    assert.equal(info!.data.length, 2176, "8 disc + 120 header + 16*128 permissions");

    const acc = await program.account.mandateAccount.fetch(mandate);
    assert.equal(acc.active, 1);
    assert.equal(acc.expiry.toString(), expiry.toString());
    assert.equal(Buffer.from(acc.owner).toString("hex"), owner.toBuffer().toString("hex"));
    assert.equal(acc.permissionsLen, 0);

    await program.methods.verifyLayout().accountsStrict({ mandate }).rpc();
    console.log("  verify_layout passed on-chain");
  });
});
