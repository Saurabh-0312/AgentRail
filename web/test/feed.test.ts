import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { foldSolana } from "@agentrail/query/src/history.ts";
import type { SolanaRow } from "@agentrail/query/src/solana-sink.ts";

import { ActivityFeed } from "../components/activity-feed";
import { actionLabel, countRows, filterRows } from "../lib/feed";
import { toFeed, type FeedRow } from "../lib/history";

const here = path.dirname(fileURLToPath(import.meta.url));
const NODE = "0x320d329cfd5eb36600e8a276ddaa5dd31e6ff7aad7637c8dfb3504725076d4ae";

/** The real Solana leg, folded exactly as the server does it, from the committed snapshot. */
function realFeed(): FeedRow[] {
  const snap = JSON.parse(fs.readFileSync(path.join(here, "../data/solana-activity.json"), "utf8")) as { rows: SolanaRow[] };
  return toFeed(foldSolana(snap.rows, NODE));
}

describe("the activity feed carries the real refusals", () => {
  it("folds the snapshot into 24 blocked rows with the codes the demo produced", () => {
    const rows = realFeed();
    const c = countRows(rows);
    expect(c.blocked).toBeGreaterThanOrEqual(24);
    expect(c.all).toBe(c.allowed + c.blocked);
    const codes = filterRows(rows, "blocked").map((r) => r.errorCode);
    for (const code of [6006, 6007, 6008, 6016, 3007]) expect(codes).toContain(code);
    // newest first
    for (let i = 1; i < rows.length; i++) expect(Number(rows[i - 1].timestamp)).toBeGreaterThanOrEqual(Number(rows[i].timestamp));
  });

  it("renders every blocked row loud: a BLOCKED badge, the code, its name and the reason, with an explorer link", () => {
    const rows = realFeed();
    const html = renderToStaticMarkup(createElement(ActivityFeed, { rows, initialMode: "blocked" }));
    const blockedRows = html.match(/data-verdict="blocked"/g) ?? [];
    expect(blockedRows.length).toBe(countRows(rows).blocked);
    expect(html).not.toMatch(/data-verdict="allowed"/);
    expect(html).toContain("BLOCKED 6016");
    expect(html).toContain("DestinationNotAllowed");
    expect(html).toContain("not on the mandate&#x27;s allowed list");
    expect(html).toContain("BLOCKED 6006");
    expect(html).toContain("InstructionNotAllowed");
    expect(html).toContain("BLOCKED 3007");
    expect(html).toContain("AccountOwnedByWrongProgram");
    // the divert revert links to the Solana explorer
    expect(html).toContain("https://explorer.solana.com/tx/5TV8UjnJvJGuydMwqikHXchTkvpSJggfnR6Ld9T5bNy2qriCNzvSTjh8qDYXgcAZKLiBPPT9zNbubHSrpVd2iYF1?cluster=devnet");
    // the red left border is on the row itself, not somewhere decorative (attribute order is React's)
    expect(html).toMatch(/<tr(?=[^>]*data-verdict="blocked")(?=[^>]*border-l-blocked)[^>]*>/);
  });

  it("keeps successes quiet and shows them all in the allowed view", () => {
    const rows = realFeed();
    const html = renderToStaticMarkup(createElement(ActivityFeed, { rows, initialMode: "allowed" }));
    expect(html).not.toMatch(/data-verdict="blocked"/);
    expect((html.match(/data-verdict="allowed"/g) ?? []).length).toBe(countRows(rows).allowed);
    expect(html).not.toContain("BLOCKED");
  });

  it("the filter is one click away and its counts add up", () => {
    const rows = realFeed();
    const html = renderToStaticMarkup(createElement(ActivityFeed, { rows }));
    const c = countRows(rows);
    expect(html).toMatch(new RegExp(`Blocked<span[^>]*>${c.blocked}</span>`));
    expect(html).toMatch(new RegExp(`All<span[^>]*>${c.all}</span>`));
    expect(filterRows(rows, "all")).toHaveLength(c.all);
  });

  it("labels the action by what actually ran", () => {
    const base = { id: "x", timestamp: "1", target: "t", amount: "0", allowed: true, blockReason: null, errorCode: null, txHash: "h", chain: "solana", mandateId: "m" };
    expect(actionLabel({ ...base, kind: "execute_payment" })).toBe("execute_payment");
    expect(actionLabel({ ...base, kind: "verify" })).toBe("verify");
    expect(actionLabel({ ...base, kind: "authorize", chain: "base" })).toBe("authorize");
  });
});
