import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { solanaOwnerGate } from "../components/solana-create";
import { SolanaRevokeView } from "../components/solana-revoke";
import { REVOKE_WARNING, revokeErrorText, revokeGate, type RevokeRead } from "../lib/solana-revoke";

const OWNER = "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb";
const OTHER = "4XwCs2E3cQcK4vEi5tE2Gi6uCKgXL1XaSyhn8LukQddV";
const PDA = "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a";
const live: RevokeRead = { active: true, expiry: Math.floor(Date.now() / 1000) + 3600, permissions: 2 };

const render = (over: Partial<Parameters<typeof SolanaRevokeView>[0]> = {}) => {
  const props = { pda: PDA, mandate: live, gate: revokeGate(solanaOwnerGate(OWNER, OWNER), live), confirm: false, progress: null, onArm: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), ...over };
  return { html: renderToStaticMarkup(createElement(SolanaRevokeView, props)), props };
};
const buttonDisabled = (html: string, id: string) => new RegExp(`<button[^>]*data-testid="${id}"[^>]*disabled`).test(html) || new RegExp(`<button[^>]*disabled[^>]*data-testid="${id}"`).test(html);

describe("the Solana revoke gate", () => {
  it("is disabled for a disconnected wallet and for the wrong account, each with its reason", () => {
    const off = revokeGate(solanaOwnerGate(null, OWNER), live);
    expect(off).toMatchObject({ enabled: false, state: "disconnected" });
    expect(off.reason).toMatch(/owner's Solana wallet/);
    const wrong = revokeGate(solanaOwnerGate(OTHER, OWNER), live);
    expect(wrong).toMatchObject({ enabled: false, state: "wrong-account" });
    expect(wrong.reason).toMatch(/not the owner/);
    for (const g of [off, wrong]) {
      const { html } = render({ gate: g });
      expect(buttonDisabled(html, "revoke-solana")).toBe(true);
      expect(html).toContain(g.reason.replace(/'/g, "&#x27;"));
    }
    expect(revokeGate(solanaOwnerGate(OWNER, OWNER), live)).toMatchObject({ enabled: true, state: "ready" });
  });

  it("disables on a missing account instead of submitting, even for the owner", () => {
    const g = revokeGate(solanaOwnerGate(OWNER, OWNER), null);
    expect(g).toMatchObject({ enabled: false, state: "missing" });
    expect(g.reason).toMatch(/no Solana mandate to revoke/);
    const { html } = render({ mandate: null, gate: g });
    expect(buttonDisabled(html, "revoke-solana")).toBe(true);
    expect(html).toContain("no account");
    expect(revokeGate(solanaOwnerGate(OWNER, OWNER), "loading").enabled).toBe(false);
  });

  it("shows the live state before offering the button: active, expiry, permission count", () => {
    const { html } = render();
    expect(html).toContain(PDA);
    expect(html).toContain("active");
    expect(html).toMatch(/expires in 1 h 0 min · 2 permissions/);
  });
});

describe("the confirm step", () => {
  it("requires an explicit confirm: the first click arms, only the second submits, and the warning names the cost", () => {
    const armed = render();
    expect(armed.html).not.toContain("revoke-solana-confirm");
    expect(armed.html).not.toContain(REVOKE_WARNING);
    const confirming = render({ confirm: true });
    expect(confirming.html).toContain('data-testid="revoke-solana-confirm"');
    expect(confirming.html).toContain(REVOKE_WARNING);
    expect(REVOKE_WARNING).toBe("This closes the mandate account. Recreating it needs all three steps again.");
    expect(confirming.html).not.toMatch(/reversible|undo/i);
    // the confirm button stays disabled for a non-owner even when armed
    expect(buttonDisabled(render({ confirm: true, gate: revokeGate(solanaOwnerGate(OTHER, OWNER), live) }).html, "revoke-solana-confirm")).toBe(true);
  });

  it("renders pending then closed with the signature linked", () => {
    const pending = render({ progress: { state: "pending", note: "sign revoke_mandate in your wallet…" } });
    expect(pending.html).toContain("pending…");
    expect(buttonDisabled(pending.html, "revoke-solana")).toBe(true);
    const sig = "5NUrNSybR39hmGtuGHWKipPvCQZT8X5y9c1JEYBDwbYystiVLsCSiBufyEyHLocG87KgZBqdzteFdi3WmHWSFTLw";
    const done = render({ mandate: null, gate: revokeGate(solanaOwnerGate(OWNER, OWNER), null), progress: { state: "confirmed", hash: sig, note: "the account is closed; its lamports went back to the owner" } });
    expect(done.html).toContain("closed");
    expect(done.html).toContain(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  });
});

describe("the program's answers", () => {
  it("maps 6009 to a clear owner-only message, and a closed account to already revoked", () => {
    const anchorErr = Object.assign(new Error("AnchorError occurred. Error Code: Unauthorized. Error Number: 6009. Error Message: signer is not the owner."), { error: { errorCode: { number: 6009, code: "Unauthorized" } } });
    expect(revokeErrorText(anchorErr, OWNER)).toBe("6009 Unauthorized: only the owner 55FJ…jvwb can revoke this mandate; the signer is not the owner");
    expect(revokeErrorText(new Error("Simulation failed. custom program error: 0x1779"), OWNER)).toMatch(/^6009 Unauthorized/);
    expect(revokeErrorText(new Error("AnchorError caused by account: mandate. Error Code: AccountNotInitialized. Error Number: 3012."), OWNER)).toMatch(/already revoked/);
    expect(revokeErrorText(new Error("User rejected the request."), OWNER)).toBe("User rejected the request.");
  });
});
