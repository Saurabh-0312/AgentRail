import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OwnerControls } from "../components/owner-controls";
import { ownerGate } from "../lib/owner";

const OWNER = "0xAa4d6f945A57b972705712B5FbadE1Fd23521069";
const VISITOR = "0x26EFd260dbE98A8f7f44555b29079d93698119be";
const mandates = {
  hedera: { id: "0xe2d86c81a0e5e638402b9af759d54ce016a66fd9e008f4e776a83c413d5440d7", active: true, agent: "0x0F07" },
  base: { id: "0xcc38df0f00000000000000000000000000000000000000000000000000c8cc", active: true, agent: "0x6FB5" },
};

describe("ownerGate", () => {
  it("is disabled with an explanation when nobody is connected", () => {
    const g = ownerGate(undefined, OWNER);
    expect(g.enabled).toBe(false);
    expect(g.state).toBe("disconnected");
    expect(g.reason).toMatch(/owner's wallet/);
    expect(g.reason).toMatch(/visitor can see them but not press them/);
  });

  it("is disabled with an explanation for a connected non-owner", () => {
    const g = ownerGate(VISITOR, OWNER);
    expect(g.enabled).toBe(false);
    expect(g.state).toBe("wrong-account");
    expect(g.reason).toMatch(/not the owner/);
  });

  it("is enabled for the owner, case-insensitively", () => {
    expect(ownerGate(OWNER.toLowerCase(), OWNER).enabled).toBe(true);
    expect(ownerGate(OWNER, OWNER.toUpperCase().replace("0X", "0x")).enabled).toBe(true);
  });
});

/**
 * A rendered control is either disabled or not; both revoke buttons and the create button count.
 * React renders the boolean attribute as `disabled=""`; the Tailwind `disabled:` variant classes
 * must not be mistaken for it.
 */
function buttons(html: string, testId: string) {
  const m = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`));
  return m ? m[0].replace(/class="[^"]*"/, "") : null;
}

describe("OwnerControls", () => {
  it("visitor: every action is visible, disabled, and explained", () => {
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(undefined, OWNER), owner: OWNER, mandates, defaultEnsName: "databot.agentrail.eth" }));
    expect(html).toContain('data-gate="disconnected"');
    expect(html).toMatch(/Needs the owner.{0,10}s wallet/);
    for (const id of ["revoke-hedera", "revoke-base", "create"]) {
      const b = buttons(html, id);
      expect(b, id).not.toBeNull();
      expect(b).toMatch(/ disabled=""/);
    }
    // the visitor still learns what the buttons do
    expect(html).toContain("revokeMandate");
    expect(html).toContain("Create mandate");
    expect(html).toContain("Add permission");
  });

  it("wrong account: still disabled, and says whose key is missing", () => {
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(VISITOR, OWNER), owner: OWNER, mandates, defaultEnsName: "databot.agentrail.eth" }));
    expect(html).toContain('data-gate="wrong-account"');
    expect(html).toMatch(/not the owner/);
    expect(buttons(html, "revoke-base")).toMatch(/ disabled=""/);
  });

  it("owner: revoke is enabled on chains with an active mandate, disabled where it is already revoked", () => {
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(OWNER, OWNER), owner: OWNER, mandates: { ...mandates, base: { ...mandates.base, active: false } }, defaultEnsName: "databot.agentrail.eth" }));
    expect(html).toContain('data-gate="owner"');
    expect(buttons(html, "revoke-hedera")).not.toMatch(/ disabled=""/);
    expect(buttons(html, "revoke-base")).toMatch(/ disabled=""/); // already revoked: nothing to revoke
  });

  it("owner: create stays disabled until the form has an agent and a payee", () => {
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(OWNER, OWNER), owner: OWNER, mandates, defaultEnsName: "databot.agentrail.eth" }));
    expect(buttons(html, "create")).toMatch(/ disabled=""/);
  });
});
