/**
 * The rules engine. Three pure rules over fetched data, then one correlated verdict. Severity is
 * decided here, deterministically; the model's job was to find the data (querySubgraph) and may
 * narrate, but it never sets severity and it is never in the enforcement path (SPEC §8.7).
 */
import { r1UnknownOrUnlimitedApproval, type R1Options } from "./r1-approval.ts";
import { r2AbnormalOutflow, type R2Options } from "./r2-outflow.ts";
import { r3LiquidationProximity, type R3Options } from "./r3-liquidation.ts";
import { SEVERITY_RANK, maxSeverity, type Finding, type RecommendedAction, type RiskData, type Severity, type Verdict } from "./types.ts";

export * from "./types.ts";
export * from "./r1-approval.ts";
export * from "./r2-outflow.ts";
export * from "./r3-liquidation.ts";
export * from "./adapt.ts";

export interface RulesOptions {
  now: number;
  r1?: Omit<R1Options, "now">;
  r2?: Omit<R2Options, "now" | "wallet">;
  r3?: R3Options;
}

/** Run every rule and return the findings, most severe first. */
export function runRules(data: RiskData, opts: RulesOptions): Finding[] {
  return [
    ...r1UnknownOrUnlimitedApproval(data.approvals, { now: opts.now, ...opts.r1 }),
    ...r2AbnormalOutflow(data.transfers, data.balances, { now: opts.now, wallet: data.wallet, ...opts.r2 }),
    ...r3LiquidationProximity(data.positions, opts.r3),
  ].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

export interface CorrelateContext {
  protocols?: string[];
  dataNotes?: string[];
}

/**
 * One verdict from the findings: the highest severity decides the action, the reasoning says why.
 * A CRITICAL (a drainer-shaped approval) outranks everything, because it can empty the account in a
 * single later transaction regardless of what else is true.
 */
export function correlate(subject: string, findings: Finding[], context: CorrelateContext = {}): Verdict {
  const severity = findings.reduce<Severity>((s, f) => maxSeverity(s, f.severity), "NONE");
  const top = findings.find((f) => f.severity === severity);
  const sentences: string[] = [];

  if (context.protocols?.length) sentences.push(`${subject} is exposed to ${context.protocols.join(", ")}.`);

  if (findings.length === 0) {
    sentences.push("No rule fired: no fresh unknown or unlimited approval, no abnormal outflow, and no lending position near liquidation.");
  } else {
    for (const f of findings) sentences.push(`${f.rule} ${f.severity}: ${f.title}.`);
    const critical = findings.filter((f) => f.severity === "CRITICAL").length;
    const high = findings.filter((f) => f.severity === "HIGH").length;
    if (critical) sentences.push(`${critical} finding(s) can drain the account in one later transaction, so the verdict is CRITICAL regardless of the rest.`);
    else if (high) sentences.push("Funds are already moving; the verdict is HIGH and the owner is told now.");
    else sentences.push("Nothing is being stolen; the verdict is MEDIUM and the position is logged for the owner.");
  }

  for (const n of context.dataNotes ?? []) sentences.push(n);

  const recommendedAction: RecommendedAction = top?.recommendedAction ?? { kind: "log", message: "no action" };
  const follow =
    recommendedAction.kind === "revokeApproval"
      ? `Recommended: revoke the approval to ${recommendedAction.spender} on ${recommendedAction.token}, through the mandate's instruction gate.`
      : recommendedAction.kind === "alertOwner"
        ? `Recommended: alert the owner (${recommendedAction.message}).`
        : `Recommended: ${recommendedAction.message}.`;
  sentences.push(follow);

  return { subject, severity, findings, reasoning: sentences.join(" "), recommendedAction, at: new Date().toISOString() };
}
