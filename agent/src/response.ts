/**
 * The graded response (SPEC §7.2; Phase 5 step 4). Severity decides what the agent may attempt,
 * and the mandate governs even the good deed:
 *
 *   MEDIUM    log it
 *   HIGH      alert the owner
 *   CRITICAL  alert the owner, then attempt the protective action through the same gate as any
 *             other request. Permitted -> the agent defends Alice, every step logged.
 *             Not permitted -> the agent can only warn.
 *
 * The protective action for a drainer approval is to kill the approval: on Alice's delegated
 * Solana account that is SPL `Revoke` (the Solana form of approve(spender, 0)), paired with
 * `verify`. There is no special path: requestAction runs the same local mirror and the same
 * on-chain instruction gate as anything else the agent asks for.
 */
import type { RecommendedAction, Severity, Verdict } from "./rules/types.ts";
import type { ActionOutcome, AgentTools, TokenAction } from "./tools.ts";
import type { RunLog } from "./transcript.ts";

export interface Alert {
  severity: Severity;
  subject: string;
  message: string;
  findings: string[];
  at: string;
}

export interface AlertReceipt {
  channel: string;
  id: string;
  explorer?: string;
}

export type AlertFn = (alert: Alert) => Promise<AlertReceipt>;

export interface ResponseConfig {
  tools: Pick<AgentTools, "requestAction">;
  /** Where HIGH and CRITICAL alerts go. Absent: the log is the channel. */
  alert?: AlertFn;
  log: RunLog;
  /** The chain the agent's delegated account lives on; protective actions elsewhere can only be warnings. */
  delegatedChain?: string;
  /** Map a recommendation to the instruction to request. Default: revokeApproval on the delegated chain -> SPL Revoke. */
  toAction?: (a: RecommendedAction, delegatedChain: string) => TokenAction | null;
}

export interface ResponseResult {
  severity: Severity;
  alert?: AlertReceipt;
  protective?: {
    action: TokenAction;
    outcome: ActionOutcome;
    /** true when the gate let the action through and the chain landed it. */
    defended: boolean;
  };
  /** Set whenever the agent could not act: the reason it can only warn. */
  warning?: string;
}

export function defaultToAction(a: RecommendedAction, delegatedChain: string): TokenAction | null {
  if (a.kind !== "revokeApproval") return null;
  if (a.chain !== delegatedChain) return null;
  return { instruction: "revoke", reason: `clear the delegation to ${a.spender} on ${a.account}` };
}

export async function respond(verdict: Verdict, cfg: ResponseConfig): Promise<ResponseResult> {
  const { log } = cfg;
  const delegatedChain = cfg.delegatedChain ?? "solana:devnet";
  const result: ResponseResult = { severity: verdict.severity };
  const findings = verdict.findings.map((f) => `${f.rule} ${f.severity}: ${f.title}`);

  const alertOwner = async () => {
    const alert: Alert = { severity: verdict.severity, subject: verdict.subject, message: verdict.reasoning, findings, at: verdict.at };
    if (!cfg.alert) {
      log.add("alert", `${verdict.severity}: owner alerted (log channel)`, { findings });
      return;
    }
    const receipt = await cfg.alert(alert);
    result.alert = receipt;
    log.add("alert", `${verdict.severity}: owner alerted via ${receipt.channel} ${receipt.id}`, { explorer: receipt.explorer, findings });
  };

  switch (verdict.severity) {
    case "NONE":
    case "LOW":
      log.add("decision", `${verdict.severity}: nothing to do`, { reasoning: verdict.reasoning });
      return result;
    case "MEDIUM":
      log.add("decision", "MEDIUM: logged for the owner, no alert, no action", { reasoning: verdict.reasoning, findings });
      return result;
    case "HIGH":
      log.add("decision", "HIGH: alert the owner, do not act", { reasoning: verdict.reasoning });
      await alertOwner();
      return result;
    case "CRITICAL": {
      log.add("decision", "CRITICAL: alert the owner, then attempt the protective action through the mandate", { reasoning: verdict.reasoning });
      await alertOwner();
      const action = (cfg.toAction ?? defaultToAction)(verdict.recommendedAction, delegatedChain);
      if (!action) {
        result.warning = `no protective action is possible: the finding is on ${"chain" in verdict.recommendedAction ? verdict.recommendedAction.chain : "a chain"} where the agent holds no delegation; the owner has been warned`;
        log.add("decision", "CRITICAL: warn only", { warning: result.warning });
        return result;
      }
      log.add("decision", `CRITICAL: request ${action.instruction} through the instruction gate`, { action });
      const outcome = await cfg.tools.requestAction(action);
      const defended = outcome.status === "executed";
      result.protective = { action, outcome, defended };
      if (defended) {
        log.add("decision", `CRITICAL: defended. ${action.instruction} landed ${outcome.signature}`, { explorer: outcome.explorer });
      } else {
        result.warning = `the mandate does not permit ${action.instruction} (${outcome.reason ?? outcome.error ?? "refused"}); the agent can only warn, and the owner has been warned`;
        log.add("decision", "CRITICAL: warn only, the mandate refused the protective action", { reason: outcome.reason, sent: outcome.sent, chainVerdict: outcome.chainVerdict });
      }
      return result;
    }
  }
}
