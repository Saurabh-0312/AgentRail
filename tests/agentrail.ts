import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Agentrail } from "../target/types/agentrail";

describe("agentrail", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.agentrail as Program<Agentrail>;

  it("initializes", async () => {
    const tx = await program.methods.initialize().rpc();
    console.log("tx", tx);
  });
});
