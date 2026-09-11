import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FundingPanel } from "../components/funding";
import { OwnerControls } from "../components/owner-controls";
import { DELEGATION_COPY, fundingStatus, requiredAllowance, stepSatisfied, suggestedAllowance } from "../lib/delegation";
import { CREATE_DEFAULTS, ownerGate } from "../lib/owner";
import { hederaLongZero, tokenFor } from "../lib/tokens";
import { ASSETS, formatUnits } from "../lib/units";

const OWNER = "0xAa4d6f945A57b972705712B5FbadE1Fd23521069";
const VISITOR = "0x26EFd260dbE98A8f7f44555b29079d93698119be";
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const fund = (allowance: string, required: string | null, balance = "135000000") => ({ token: BASE_USDC, symbol: "USDC", decimals: 6, allowance, balance, required });
const mandates = {
  hedera: { id: "0xe2d86c81a0e5e638402b9af759d54ce016a66fd9e008f4e776a83c413d5440d7", active: true, agent: "0x0F07", funding: { ...fund("0", "30000", "0"), token: hederaLongZero("0.0.429274") } },
  base: { id: "0xcc38df0f00000000000000000000000000000000000000000000000000c8cc", active: true, agent: "0x6FB5", funding: fund("0", "374") },
};

/** A rendered control's tag, class attribute stripped so `disabled=""` cannot be confused with a `disabled:` class. */
function control(html: string, testId: string, tag = "button") {
  const m = html.match(new RegExp(`<${tag}[^>]*data-testid="${testId}"[^>]*>`));
  return m ? m[0].replace(/class="[^"]*"/, "") : null;
}

describe("the token a mandate pulls", () => {
  it("defaults per chain from the asset registry, with the HTS id in its long-zero form", () => {
    expect(tokenFor("base")?.address).toBe(ASSETS["usdc-base"].id);
    expect(tokenFor("hedera")?.address).toBe("0x0000000000000000000000000000000000068cda");
    expect(hederaLongZero("0.0.429274")).toBe("0x0000000000000000000000000000000000068cda");
    expect(tokenFor("solana")).toBeNull();
    expect(tokenFor("sepolia")).toBeNull();
    expect(() => hederaLongZero("0x036C")).toThrow(RangeError);
  });
});

describe("what a mandate needs delegated", () => {
  it("is the sum of every permission's remaining lifetime cap, unlimited when a cap is 0", () => {
    expect(requiredAllowance([{ total: "500", spent: "126" }])).toBe("374");
    expect(requiredAllowance([{ total: "50000", spent: "20000" }, { total: "1000", spent: "0" }])).toBe("31000");
    expect(requiredAllowance([{ total: "500", spent: "600" }])).toBe("0");
    expect(requiredAllowance([{ total: "0", spent: "0" }])).toBeNull();
    expect(requiredAllowance([])).toBe("0");
  });

  it("grades the allowance against it", () => {
    expect(fundingStatus(fund("0", "374"))).toEqual({ state: "unfunded", shortfall: "374", balanceShort: false });
    expect(fundingStatus(fund("100", "374"))).toEqual({ state: "under-funded", shortfall: "274", balanceShort: false });
    expect(fundingStatus(fund("374", "374"))).toEqual({ state: "funded", shortfall: "0", balanceShort: false });
    expect(fundingStatus(fund("50000", "374"))).toMatchObject({ state: "funded" });
    expect(fundingStatus(fund("50000", "0"))).toMatchObject({ state: "nothing-to-fund" });
    expect(fundingStatus(fund("0", null))).toMatchObject({ state: "unfunded" });
    expect(fundingStatus(fund("1", null))).toMatchObject({ state: "funded" });
    // an allowance the balance cannot back is flagged, not hidden
    expect(fundingStatus(fund("30000", "30000", "0"))).toEqual({ state: "funded", shortfall: "0", balanceShort: true });
  });

  it("marks step 3 satisfied only when the standing allowance covers the amount", () => {
    expect(stepSatisfied("50000", "50000")).toBe(true);
    expect(stepSatisfied("60000", "50000")).toBe(true);
    expect(stepSatisfied("49999", "50000")).toBe(false);
    expect(stepSatisfied("0", "50000")).toBe(false);
    expect(stepSatisfied("50000", "0")).toBe(false);
    expect(stepSatisfied("nope", "5")).toBe(false);
  });

  it("suggests the absolute allowance that covers the caps", () => {
    expect(suggestedAllowance(fund("0", "374"))).toBe("374");
    expect(suggestedAllowance(fund("100", "374"))).toBe("374");
    expect(suggestedAllowance(fund("900", null))).toBe("900");
    expect(suggestedAllowance(fund("0", null))).toBe("0");
  });
});

describe("the create form", () => {
  it("pre-fills the approve amount from the lifetime cap, with the human conversion per asset", () => {
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(OWNER, OWNER), owner: OWNER, mandates, defaultEnsName: "databot.agentrail.eth" }));
    const approve = control(html, "approve-amount", "input");
    expect(approve).toMatch(new RegExp(`value="${CREATE_DEFAULTS.total}"`));
    expect(formatUnits(CREATE_DEFAULTS.total, ASSETS["usdc-base"].decimals, "USDC").human).toBe("0.05 USDC");
    expect(html).toContain("0.05 USDC");
    // the token defaults from the chain (Base first) and can be overridden: it is an input, not a constant
    expect(control(html, "token", "input")).toContain(`value="${BASE_USDC}"`);
    expect(formatUnits("30000", ASSETS["usdc-hedera"].decimals, "USDC").human).toBe("0.03 USDC");
  });

  it("shows three numbered steps, and a visitor can press none of them", () => {
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(undefined, OWNER), owner: OWNER, mandates, defaultEnsName: "databot.agentrail.eth" }));
    for (const n of [1, 2, 3]) expect(html).toContain(`${n} of 3`);
    expect(html).toContain("createMandate(agent, ensNode, expiry)");
    expect(html).toContain("approve(EvmMandate, amount)");
    for (const id of ["create", "delegate-base", "delegate-hedera", "revoke-base", "revoke-hedera"]) {
      const b = control(html, id);
      expect(b, id).not.toBeNull();
      expect(b).toMatch(/ disabled=""/);
    }
    expect(html).toContain(DELEGATION_COPY);
  });

  it("a non-owner is just as locked out", () => {
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(VISITOR, OWNER), owner: OWNER, mandates, defaultEnsName: "databot.agentrail.eth" }));
    for (const id of ["create", "delegate-base", "delegate-hedera"]) expect(control(html, id)).toMatch(/ disabled=""/);
  });

  it("an allowance already covering the cap marks the delegation satisfied; an owner may still raise it", () => {
    const funded = { ...mandates, base: { ...mandates.base, funding: fund("50000", "374") } };
    const html = renderToStaticMarkup(createElement(OwnerControls, { gate: ownerGate(OWNER, OWNER), owner: OWNER, mandates: funded, defaultEnsName: "databot.agentrail.eth" }));
    expect(html).toMatch(/data-testid="delegate-base-status"[^>]*>.*?funded/);
    expect(html).toContain("the current allowance already covers this");
    expect(control(html, "delegate-base")).not.toMatch(/ disabled=""/);
    expect(control(html, "delegate-base-amount", "input")).toContain('value="374"');
    // the unfunded chain next to it is loud
    expect(html).toMatch(/data-testid="delegate-hedera-row"[^>]*data-funding="unfunded"/);
  });
});

describe("the funding warning on the agent page", () => {
  it("flags an existing mandate with no allowance, with the fix one click away", () => {
    const html = renderToStaticMarkup(createElement(FundingPanel, { chain: "base", funding: fund("0", "374"), active: true }));
    expect(html).toContain('data-funding="unfunded"');
    expect(html).toContain("Not funded");
    expect(html).toContain("cannot pull funds");
    expect(html).toContain('href="#delegate"');
    expect(html).toContain("Delegate funds");
    expect(html).toContain(DELEGATION_COPY);
    expect(html).toContain("0.000374 USDC");
  });

  it("flags an allowance below the caps as under-funded with the shortfall", () => {
    const html = renderToStaticMarkup(createElement(FundingPanel, { chain: "hedera", funding: fund("10000", "30000"), active: true }));
    expect(html).toContain('data-funding="under-funded"');
    expect(html).toContain("Under-funded");
    expect(html).toContain("0.02 USDC");
  });

  it("stays quiet for a funded mandate and for a revoked one", () => {
    expect(renderToStaticMarkup(createElement(FundingPanel, { chain: "base", funding: fund("50000", "374"), active: true }))).not.toContain("Not funded");
    expect(renderToStaticMarkup(createElement(FundingPanel, { chain: "base", funding: fund("50000", "374"), active: true }))).toContain('data-funding="funded"');
    expect(renderToStaticMarkup(createElement(FundingPanel, { chain: "base", funding: fund("0", "374"), active: false }))).not.toContain("Not funded");
  });
});
