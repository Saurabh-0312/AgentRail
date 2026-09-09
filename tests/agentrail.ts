import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import {
  MANDATE_SEED,
  MAX_PERMISSIONS,
  bytes32,
  disc8,
  expectAnchorError,
  expectReject,
  nowSec,
  sameKey,
  setup,
} from "./helpers";

// Lifecycle tests: create_mandate, add_permission, remove_permission, revoke_mandate.
// Every reject path is asserted by Anchor error code, never by "it threw something".

describe("agentrail lifecycle", () => {
  const { provider, program, owner } = setup();

  const agent = Keypair.generate();
  const intruder = Keypair.generate();
  const ensNode = bytes32(0xab);
  const expiry = new BN(nowSec() + 3600);

  const [mandate] = PublicKey.findProgramAddressSync(
    [MANDATE_SEED, owner.toBuffer(), agent.publicKey.toBuffer()],
    program.programId,
  );

  const targetProgram = Keypair.generate().publicKey;
  const otherProgram = Keypair.generate().publicKey;

  const addPermission = (
    programId: PublicKey,
    opts: Partial<{
      discriminators: number[][];
      size: number;
      spendLimit: BN;
      perTxLimit: BN;
      signer: Keypair;
      account: PublicKey;
    }> = {},
  ) => {
    const b = program.methods
      .addPermission(
        programId,
        opts.discriminators ?? [disc8(0x11)],
        opts.size ?? 8,
        opts.spendLimit ?? new BN(1_000_000),
        opts.perTxLimit ?? new BN(100_000),
      )
      .accountsStrict({
        mandate: opts.account ?? mandate,
        owner: opts.signer ? opts.signer.publicKey : owner,
      });
    return opts.signer ? b.signers([opts.signer]).rpc() : b.rpc();
  };

  describe("create_mandate", () => {
    it("rejects an expiry in the past", async () => {
      const staleAgent = Keypair.generate();
      const [stale] = PublicKey.findProgramAddressSync(
        [MANDATE_SEED, owner.toBuffer(), staleAgent.publicKey.toBuffer()],
        program.programId,
      );
      await expectAnchorError(
        program.methods
          .createMandate(ensNode, new BN(nowSec() - 100))
          .accountsStrict({ mandate: stale, owner, agent: staleAgent.publicKey, systemProgram: SystemProgram.programId })
          .rpc(),
        "InvalidExpiry",
      );
    });

    it("creates a mandate with every field set", async () => {
      await program.methods
        .createMandate(ensNode, expiry)
        .accountsStrict({ mandate, owner, agent: agent.publicKey, systemProgram: SystemProgram.programId })
        .rpc();

      const m = await program.account.mandateAccount.fetch(mandate);
      assert.equal(m.active, 1);
      assert.isTrue(sameKey(m.owner as number[], owner), "owner");
      assert.isTrue(sameKey(m.agent as number[], agent.publicKey), "agent");
      assert.deepEqual(m.ensNode as number[], ensNode);
      assert.isTrue((m.expiry as BN).eq(expiry));
      assert.equal(m.permissionsLen, 0);

      const [, bump] = PublicKey.findProgramAddressSync(
        [MANDATE_SEED, owner.toBuffer(), agent.publicKey.toBuffer()],
        program.programId,
      );
      assert.equal(m.bump, bump);

      const info = await provider.connection.getAccountInfo(mandate);
      assert.equal(info!.data.length, 2176, "account size matches SPEC §8.2");
      assert.isTrue(info!.owner.equals(program.programId));
    });

    it("rejects a second mandate for the same owner and agent", async () => {
      await expectReject(
        program.methods
          .createMandate(ensNode, expiry)
          .accountsStrict({ mandate, owner, agent: agent.publicKey, systemProgram: SystemProgram.programId })
          .rpc(),
        "already in use",
      );
    });
  });

  describe("add_permission", () => {
    it("rejects a signer who is not the owner", async () => {
      await expectAnchorError(addPermission(targetProgram, { signer: intruder }), "Unauthorized");
    });

    it("rejects a discriminator size other than 1, 4 or 8", async () => {
      await expectAnchorError(addPermission(targetProgram, { size: 3 }), "InvalidDiscriminatorSize");
    });

    it("rejects more than 8 discriminators", async () => {
      const nine = Array.from({ length: 9 }, (_, i) => disc8(i));
      await expectAnchorError(addPermission(targetProgram, { discriminators: nine }), "TooManyDiscriminators");
    });

    it("adds a permission and stores every field", async () => {
      const discs = [disc8(0x11), disc8(0x22), disc8(0x33)];
      await addPermission(targetProgram, {
        discriminators: discs,
        size: 8,
        spendLimit: new BN(5_000_000),
        perTxLimit: new BN(250_000),
      });

      const m = await program.account.mandateAccount.fetch(mandate);
      assert.equal(m.permissionsLen, 1);
      const p = m.permissions[0];
      assert.isTrue(sameKey(p.programId as number[], targetProgram));
      assert.isTrue((p.spendLimit as BN).eqn(5_000_000));
      assert.isTrue((p.perTxLimit as BN).eqn(250_000));
      assert.isTrue((p.spendTotal as BN).isZero());
      assert.equal(p.callCount, 0);
      assert.equal(p.discriminatorsLen, 3);
      assert.equal(p.discriminatorSize, 8);
      assert.deepEqual(p.discriminators.slice(0, 3), discs);
      assert.deepEqual(p.discriminators[3], disc8(0), "unused slots stay zero");
    });

    it("rejects a duplicate program", async () => {
      await expectAnchorError(addPermission(targetProgram), "DuplicatePermission");
    });

    it("accepts the 1-byte SPL Token discriminator width", async () => {
      await addPermission(otherProgram, { discriminators: [[3, 0, 0, 0, 0, 0, 0, 0]], size: 1 });
      const m = await program.account.mandateAccount.fetch(mandate);
      assert.equal(m.permissionsLen, 2);
      assert.equal(m.permissions[1].discriminatorSize, 1);
    });

    it("rejects the 17th permission", async () => {
      const fullAgent = Keypair.generate();
      const [full] = PublicKey.findProgramAddressSync(
        [MANDATE_SEED, owner.toBuffer(), fullAgent.publicKey.toBuffer()],
        program.programId,
      );
      await program.methods
        .createMandate(ensNode, expiry)
        .accountsStrict({ mandate: full, owner, agent: fullAgent.publicKey, systemProgram: SystemProgram.programId })
        .rpc();

      for (let i = 0; i < MAX_PERMISSIONS; i++) {
        await addPermission(Keypair.generate().publicKey, { account: full });
      }
      const m = await program.account.mandateAccount.fetch(full);
      assert.equal(m.permissionsLen, MAX_PERMISSIONS);

      await expectAnchorError(
        addPermission(Keypair.generate().publicKey, { account: full }),
        "PermissionsFull",
      );
    });
  });

  describe("remove_permission", () => {
    it("rejects a signer who is not the owner", async () => {
      await expectAnchorError(
        program.methods
          .removePermission(targetProgram)
          .accountsStrict({ mandate, owner: intruder.publicKey })
          .signers([intruder])
          .rpc(),
        "Unauthorized",
      );
    });

    it("rejects a program that has no entry", async () => {
      await expectAnchorError(
        program.methods
          .removePermission(Keypair.generate().publicKey)
          .accountsStrict({ mandate, owner })
          .rpc(),
        "PermissionNotFound",
      );
    });

    it("swap-removes the first entry and zeroes the vacated slot", async () => {
      await program.methods.removePermission(targetProgram).accountsStrict({ mandate, owner }).rpc();

      const m = await program.account.mandateAccount.fetch(mandate);
      assert.equal(m.permissionsLen, 1);
      assert.isTrue(sameKey(m.permissions[0].programId as number[], otherProgram), "last entry moved to slot 0");
      assert.deepEqual(m.permissions[1].programId as number[], bytes32(0), "vacated slot is zero");
      assert.equal(m.permissions[1].discriminatorsLen, 0);
    });

    it("removes the last remaining entry", async () => {
      await program.methods.removePermission(otherProgram).accountsStrict({ mandate, owner }).rpc();
      const m = await program.account.mandateAccount.fetch(mandate);
      assert.equal(m.permissionsLen, 0);
    });
  });

  describe("revoke_mandate", () => {
    it("rejects a signer who is not the owner", async () => {
      await expectAnchorError(
        program.methods
          .revokeMandate()
          .accountsStrict({ mandate, owner: intruder.publicKey })
          .signers([intruder])
          .rpc(),
        "Unauthorized",
      );
      const m = await program.account.mandateAccount.fetch(mandate);
      assert.equal(m.active, 1, "mandate untouched");
    });

    it("closes the account and returns rent to the owner", async () => {
      const before = await provider.connection.getBalance(owner);
      const rent = (await provider.connection.getAccountInfo(mandate))!.lamports;

      await program.methods.revokeMandate().accountsStrict({ mandate, owner }).rpc();

      const info = await provider.connection.getAccountInfo(mandate);
      assert.isNull(info, "account no longer exists");
      const after = await provider.connection.getBalance(owner);
      // Rent comes back minus one transaction fee.
      assert.isAbove(after, before + rent - 10_000);
    });

    it("rejects any further use of the revoked mandate", async () => {
      await expectAnchorError(addPermission(targetProgram), "AccountOwnedByWrongProgram");
    });
  });
});
