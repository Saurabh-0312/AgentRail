/**
 * The whole story, one command.
 *
 *   yarn workspace @agentrail/agent demo [identity|monitor|defend|attack|all]
 *
 *   identity  the agent starts from an ENS name: rail.allowed says what it may buy, and the fixed
 *             query says what it has already spent on three chains
 *   monitor   the risk-monitor job: a discovery pass over published subgraphs finds which protocols
 *             the watched wallet is in, drills into them, buys prices through the mandate, and
 *             correlates one verdict
 *   defend    Alice is phished: a real delegation to an unknown key is signed on her own token
 *             account. The monitor sees it, calls it CRITICAL, and tries the protective action.
 *             Run once with the mandate as issued (Revoke not permitted -> the agent can only warn)
 *             and once after Alice permits Revoke (-> the agent defends her, on chain)
 *   attack    a real model, a poisoned feed response, three sincere attempts, three refusals
 *
 * Every stage appends to one transcript (agent/out, gitignored). Nothing here decides an outcome
 * the chain should decide: the gate is always the on-chain program.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createAttackRuntime, runAttack, type AttackResult } from "./attack/run.ts";
import { runMonitor, type MonitorReport } from "./monitor.ts";
import { respond, type ResponseResult } from "./response.ts";
import { correlate, fromMandateView, runRules, type Verdict } from "./rules/index.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import { SPL_TOKEN_TAG } from "@agentrail/sdk";
import { RunLog, stringify } from "./transcript.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(here, "../out");

const ATTACKER = process.env.ATTACKER_WALLET ?? "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const WATCHED = process.env.ALICE_WALLET ?? "";

const rule = (title: string) => console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);

/**
 * The agent's own delegated account, judged by the rules. This is the budget-aware half of the
 * monitor: the fixed query plus a live account read, no MCP, no model.
 */
export async function assessOwnAccount(rt: Runtime, log: RunLog): Promise<Verdict> {
  const now = Math.floor(Date.now() / 1000);
  const view = await rt.tools.getMyMandate();
  const own = fromMandateView(view, { now, ownerWallet: rt.solana.owner });
  const findings = runRules({ wallet: rt.solana.ownerTokenAccount, ...own, positions: [] }, { now, r1: { knownSpenders: new Set([rt.solana.mandate.toLowerCase()]) } });
  for (const f of findings) log.add("finding", `${f.rule} ${f.severity}: ${f.title}`, { evidence: f.evidence });
  const verdict = correlate(rt.solana.ownerTokenAccount, findings);
  log.add("verdict", `${verdict.severity}: ${verdict.reasoning}`, { recommendedAction: verdict.recommendedAction });
  return verdict;
}

async function stageIdentity(rt: Runtime, log: RunLog) {
  rule("1. the agent starts from a name");
  console.log(`  ${rt.agentName}`);
  for (const [k, v] of Object.entries(rt.self)) if (v) console.log(`    ${k.padEnd(20)} ${v.slice(0, 120)}`);
  const view = await rt.tools.getMyMandate();
  console.log(`\n  budget, read with the fixed query (never the MCP):`);
  for (const c of view.chains) {
    console.log(`    ${c.chain.padEnd(9)} ${c.active ? "active  " : "inactive"} ${c.permissions.length} permission(s), ${c.actions.total} action(s), ${c.actions.blocked} blocked ${JSON.stringify(c.actions.blockedReasons)}`);
  }
  if (view.solana?.delegation) {
    const d = view.solana.delegation;
    console.log(`    delegated account ${d.account}: balance ${d.balance}, delegate ${d.delegate ?? "none"} ${d.delegateIsMandate ? "(the mandate)" : "(NOT the mandate)"}`);
  }
  return view;
}

async function stageMonitor(rt: Runtime, log: RunLog): Promise<MonitorReport | undefined> {
  if (!WATCHED) {
    console.log("\n  (skipped: set ALICE_WALLET to a mainnet address for the discovery pass)");
    return undefined;
  }
  rule(`2. the job: is ${WATCHED} about to lose money?`);
  const report = await runMonitor({ wallet: WATCHED, tools: rt.tools, log, feedService: rt.feedService, knownSpenders: [rt.solana.mandate], ownerWallet: rt.solana.owner });
  console.log(`\n  protocols discovered: ${report.protocols.map((p) => p.name).join(", ") || "(none)"}`);
  for (const d of report.drills) console.log(`    ${d.name.padEnd(22)} ${d.parsed} row(s) parsed`);
  if (report.purchase?.status === "paid") console.log(`  data bought through the mandate: ${report.purchase.amount} units, ${report.purchase.transactionId}`);
  console.log(`  VERDICT ${report.verdict.severity}: ${report.verdict.reasoning}`);
  return report;
}

/**
 * The protective action, governed. Alice is phished for real on chain, the monitor judges her own
 * account, and the agent tries to defend her twice: once when the mandate forbids Revoke, once when
 * it permits it. Same code path, same gate, opposite outcomes.
 */
async function stageDefend(rt: Runtime, log: RunLog): Promise<{ refused: ResponseResult; permitted: ResponseResult }> {
  rule("3. Alice is phished, and the mandate governs even the good deed");
  const staged = await rt.solana.stageDrainerApproval(ATTACKER);
  console.log(`  Alice signs a delegation to ${ATTACKER} (the phishing event)\n    https://explorer.solana.com/tx/${staged}?cluster=devnet`);
  log.add("note", `staged the drainer approval: ${ATTACKER} is now the delegate on Alice's token account`, { signature: staged });

  try {
    const verdict = await assessOwnAccount(rt, log);
    console.log(`\n  monitor VERDICT ${verdict.severity}: ${verdict.reasoning}`);

    console.log(`\n  3a. the mandate as issued permits SPL Token Transfer only`);
    const refused = await respond(verdict, { tools: rt.tools, alert: rt.alert, log });
    console.log(`      protective action: ${refused.protective?.outcome.status ?? "none"} (${refused.protective?.outcome.reason ?? "-"}), sent to chain: ${refused.protective?.outcome.sent ?? false}`);
    if (refused.protective?.outcome.chainVerdict) console.log(`      chain: REVERTED ${refused.protective.outcome.chainVerdict.errorName} ${refused.protective.outcome.chainVerdict.explorer}`);
    console.log(`      -> ${refused.warning ?? "acted"}`);

    console.log(`\n  3b. Alice permits Revoke on the same mandate`);
    const widened = await rt.solana.setTokenInstructions([SPL_TOKEN_TAG.transfer, SPL_TOKEN_TAG.revoke]);
    console.log(`      add_permission(SPL Token: Transfer, Revoke) https://explorer.solana.com/tx/${widened.added}?cluster=devnet`);
    log.add("note", "owner widened the mandate to permit Revoke", widened);
    const verdict2 = await assessOwnAccount(rt, log);
    const permitted = await respond(verdict2, { tools: rt.tools, alert: rt.alert, log });
    console.log(`      protective action: ${permitted.protective?.outcome.status ?? "none"} ${permitted.protective?.outcome.explorer ?? ""}`);
    console.log(`      -> ${permitted.protective?.defended ? "the agent defended Alice; the drainer delegation is gone" : (permitted.warning ?? "warned only")}`);
    return { refused, permitted };
  } finally {
    // leave the account as demo:devnet leaves it: the mandate PDA is the delegate, Transfer only
    const restored = await rt.solana.restoreDelegate();
    const narrowed = await rt.solana.setTokenInstructions([SPL_TOKEN_TAG.transfer]);
    log.add("note", "restored: mandate PDA is delegate again, SPL Token permission back to Transfer only", { restored, narrowed: narrowed.added });
  }
}

async function stageAttack(log: RunLog): Promise<AttackResult[]> {
  rule("4. a real model, a poisoned feed response, three sincere attempts");
  const results: AttackResult[] = [];
  const { rt, poison } = await createAttackRuntime(log);
  try {
    for (const kind of ["divert", "seize", "replay"] as const) results.push(await runAttack(kind, rt, poison, log));
  } finally {
    await rt.close();
  }
  console.log("");
  for (const r of results) {
    console.log(`  [${r.kind}] injected=${r.injected} modelAttempted=${r.modelAttempted} refused=${r.refused}`);
    if (r.revertedTx) console.log(`      REVERTED ${r.errorName ?? ""}${r.errorCode ? ` (${r.errorCode})` : ""} ${r.explorer}`);
    if (r.note) console.log(`      NOTE: ${r.note}`);
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith("demo.ts")) {
  const stage = process.argv[2] ?? "all";
  const log = new RunLog(`demo_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  const needsMcp = stage === "all" || stage === "monitor";
  const rt = await createRuntime({ log, mcp: needsMcp, evmRails: ["hedera"] });
  const summary: Record<string, unknown> = { stage, agent: rt.agentName, at: new Date().toISOString() };
  try {
    if (stage === "all" || stage === "identity") summary.identity = await stageIdentity(rt, log);
    if (stage === "all" || stage === "monitor") summary.monitor = (await stageMonitor(rt, log))?.verdict;
    if (stage === "all" || stage === "defend") summary.defend = await stageDefend(rt, log);
    if (stage === "all" || stage === "attack") summary.attack = await stageAttack(log);
  } finally {
    const files = log.write(OUT_DIR);
    console.log(`\ntranscript ${files.md}\n           ${files.json}`);
    await rt.close();
  }
  console.log(`\nsummary ${stringify(summary).slice(0, 400)}`);
}
