/**
 * runAgent(goal): one model, the tool surface, a bounded loop. The model decides what to call and
 * with what; the tools are plain functions and the mandate has the last word (SPEC §8.7). Every
 * statement the model makes before a call is logged, so a transcript shows what it intended.
 */
import { messagesFromEnv, type MessagesApi } from "./explore.ts";
import { TOOL_SPECS, callTool, type AgentTools } from "./tools.ts";
import { stringify, type RunLog } from "./transcript.ts";

export const AGENT_SYSTEM = `You are Databot (databot.agentrail.eth), an autonomous risk-monitor agent working for Alice.
Your job is to watch Alice's funds and act to protect them. Alice issued you a mandate: you may buy data
and take protective actions on her delegated USDC account, within what the mandate permits. The on-chain
gate has the final word; a refusal is final, so never retry a refused action.
Tools: discoverService (ENS name -> service), querySubgraph (a natural-language question over public
subgraphs), getMyMandate (your caps, spend, remaining, active, expiry, permitted instructions; a fixed
query), requestPayment (buy from a service by ENS name, or pay a wallet on solana:devnet), requestAction
(an SPL Token instruction on Alice's delegated account: approve, revoke, setAuthority, closeAccount).
Before every tool call, state in one sentence what you are about to do and why. When you are done,
summarise what you did, what was refused and why, and what Alice should know. Never invent data or
transaction ids; only report what the tools returned.`;

interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  signature?: string;
}
interface TextBlock {
  type: "text";
  text: string;
  signature?: string;
}
interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface AgentStep {
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  /** What the model said right before the call. */
  said: string;
}

export interface AgentRun {
  goal: string;
  answer: string;
  steps: AgentStep[];
  model: string;
  /** Every text the model produced, in order: the intent trail. */
  statements: string[];
}

export interface RunAgentOptions {
  api?: MessagesApi;
  model?: string;
  maxSteps?: number;
  toolResultChars?: number;
  system?: string;
  /** Restrict the tools the model sees (names). Default: all five. */
  tools?: (keyof AgentTools)[];
}

export async function runAgent(goal: string, tools: AgentTools, log: RunLog, opts: RunAgentOptions = {}): Promise<AgentRun> {
  const provider = opts.api ? { api: opts.api, model: opts.model ?? "custom", toolResultChars: opts.toolResultChars ?? 60_000 } : messagesFromEnv();
  const model = opts.model ?? provider.model;
  const toolResultChars = opts.toolResultChars ?? provider.toolResultChars;
  const maxSteps = opts.maxSteps ?? 10;
  const specs = TOOL_SPECS.filter((t) => !opts.tools || opts.tools.includes(t.name));
  const history: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: goal }];
  const steps: AgentStep[] = [];
  const statements: string[] = [];
  log.add("note", `runAgent (${model})`, { goal: goal.slice(0, 600) });

  for (let i = 0; i <= maxSteps; i++) {
    const res = await provider.api({ model, max_tokens: 1500, system: opts.system ?? AGENT_SYSTEM, tools: specs, messages: history });
    history.push({ role: "assistant", content: res.content });
    const said = res.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join(" ");
    if (said) {
      statements.push(said);
      log.add("model", said.slice(0, 1500));
    }
    const uses = res.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0 || i === maxSteps) {
      return { goal, answer: said || "(no answer)", steps, model, statements };
    }
    const results: ToolResult[] = [];
    for (const u of uses) {
      log.add("decision", `model calls ${u.name}`, { input: u.input });
      let output: unknown;
      try {
        output = await callTool(tools, u.name, u.input);
      } catch (e) {
        output = { error: e instanceof Error ? e.message : String(e) };
        log.add("note", `${u.name} threw: ${(output as { error: string }).error}`);
      }
      steps.push({ tool: u.name, input: u.input, output, said });
      results.push({ type: "tool_result", tool_use_id: u.id, content: stringify(output).slice(0, toolResultChars) });
    }
    history.push({ role: "user", content: results });
  }
  return { goal, answer: "(no answer)", steps, model, statements };
}
