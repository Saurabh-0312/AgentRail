/**
 * Ask a natural-language question about published, third-party subgraphs. A model drives the
 * Subgraph MCP tools (search -> schema -> query -> answer); nothing here touches the mandate or our
 * own index. This is the exploration half of SPEC §8.7 and the input side of the Phase 5 risk
 * monitor ("which protocols is Alice exposed to?").
 *
 *   yarn workspace @agentrail/agent explore "Which ENS names were registered most recently on mainnet?"
 *
 * Env: GRAPH_API_KEY (the MCP) and one model provider, tried in this order: GEMINI_API_KEY
 * (default gemini-flash-latest), GROQ_API_KEY (default openai/gpt-oss-120b), ANTHROPIC_API_KEY
 * (default claude-sonnet-5). AGENT_MODEL overrides the model name.
 */
import { connectSubgraphMcp, type McpTool, type SubgraphMcp } from "./mcp.ts";

const SYSTEM = `You explore subgraphs published on The Graph Network on behalf of an on-chain agent.
Use the tools: search_subgraphs_by_keyword to find candidate subgraphs, get_schema_by_subgraph_id to
learn their entities, execute_query_by_subgraph_id to run a GraphQL query (keep queries small: first: 5).
Prefer subgraphs with signal and recent query counts. When you have the data, answer in a few plain
sentences and name the subgraph id you used. If nothing fits, say so. Never invent data.`;

interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Gemini thinking models sign each call and require the signature back when the history is replayed. */
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
type Block = ToolUse | TextBlock;

export interface ExploreStep {
  tool: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ExploreResult {
  question: string;
  answer: string;
  steps: ExploreStep[];
  model: string;
}

/** A Messages-shaped call: Anthropic's format, which the Groq adapter translates to and from. */
export type MessagesApi = (body: Record<string, unknown>) => Promise<{ content: Block[]; stop_reason: string }>;

/** The Anthropic Messages API over fetch, so the package carries no SDK. */
export function anthropicMessages(apiKey: string): MessagesApi {
  return async (body) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { content?: Block[]; stop_reason?: string; error?: { message: string } };
    if (!res.ok || json.error) throw new Error(`anthropic: ${json.error?.message ?? res.status}`);
    return { content: json.content ?? [], stop_reason: json.stop_reason ?? "end_turn" };
  };
}

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OaiMessage {
  role: string;
  content: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

/**
 * Groq (OpenAI-compatible chat completions with tool calling) behind the same Messages-shaped
 * interface, so the loop below does not care which provider answers.
 */
export function groqMessages(apiKey: string): MessagesApi {
  return async (body) => {
    const tools = (body.tools as { name: string; description: string; input_schema: unknown }[]).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const messages: OaiMessage[] = [{ role: "system", content: body.system as string }];
    for (const m of body.messages as { role: string; content: unknown }[]) {
      if (typeof m.content === "string") {
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      const blocks = m.content as (Block | ToolResult)[];
      if (m.role === "assistant") {
        const text = blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join(" ");
        const calls: OaiToolCall[] = blocks
          .filter((b): b is ToolUse => b.type === "tool_use")
          .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }));
        messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        for (const b of blocks) {
          if (b.type === "tool_result") messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
        }
      }
    }
    // The free tier meters tokens per minute, so wait out a 429 rather than fail the question. The
    // model also emits malformed tool-call arguments now and then, which the API rejects with a 400
    // ("Failed to parse tool call arguments as JSON"); that is a bad sample, so just ask again.
    let res: Response | undefined;
    let json: { choices?: { message: OaiMessage; finish_reason: string }[]; error?: { message: string } } = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: body.model, max_tokens: body.max_tokens, messages, tools, tool_choice: "auto" }),
      });
      json = (await res.json().catch(() => ({}))) as typeof json;
      const message = json.error?.message ?? "";
      const badSample = res.status === 400 && /tool call|arguments/i.test(message);
      if (res.status !== 429 && res.status < 500 && !badSample) break;
      if (badSample || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const wait = Number(message.match(/try again in ([\d.]+)s/)?.[1] ?? 15) + 1;
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    if (!res || !res.ok || json.error) throw new Error(`groq: ${json.error?.message ?? res?.status}`);
    const msg = json.choices?.[0]?.message;
    const content: Block[] = [];
    if (msg?.content) content.push({ type: "text", text: msg.content });
    for (const c of msg?.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
    }
    return { content, stop_reason: msg?.tool_calls?.length ? "tool_use" : "end_turn" };
  };
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

/**
 * Gemini (`generateContent` with function calling) behind the same Messages-shaped interface.
 * Gemini keys function responses by name, not id; the loop's tool ids are `<name>#<n>` so the
 * name can be recovered.
 */
export function geminiMessages(apiKey: string): MessagesApi {
  return async (body) => {
    const tools = [{ functionDeclarations: (body.tools as { name: string; description: string; input_schema: unknown }[]).map((t) => ({ name: t.name, description: t.description, parameters: stripSchema(t.input_schema) })) }];
    const contents: { role: "user" | "model"; parts: GeminiPart[] }[] = [];
    for (const m of body.messages as { role: string; content: unknown }[]) {
      if (typeof m.content === "string") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
        continue;
      }
      const blocks = m.content as (Block | ToolResult)[];
      if (m.role === "assistant") {
        const parts: GeminiPart[] = [];
        for (const b of blocks) {
          if (b.type === "text" && b.text) parts.push({ text: b.text, ...(b.signature ? { thoughtSignature: b.signature } : {}) });
          if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input }, ...(b.signature ? { thoughtSignature: b.signature } : {}) });
        }
        if (parts.length) contents.push({ role: "model", parts });
      } else {
        const parts: GeminiPart[] = blocks
          .filter((b): b is ToolResult => b.type === "tool_result")
          .map((b) => ({ functionResponse: { name: b.tool_use_id.split("#")[0], response: { output: b.content } } }));
        if (parts.length) contents.push({ role: "user", parts });
      }
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent?key=${apiKey}`;
    let res: Response | undefined;
    let json: { candidates?: { content?: { parts?: GeminiPart[] } }[]; error?: { message: string; code?: number } } = {};
    // The free tier meters requests per minute (20 on the flash models) and says how long to wait;
    // honour that hint rather than guess, or a busy minute fails the whole run.
    for (let attempt = 0; attempt < 6; attempt++) {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: body.system as string }] }, contents, tools, generationConfig: { maxOutputTokens: body.max_tokens, temperature: 0.2 } }),
      });
      json = (await res.json().catch(() => ({}))) as typeof json;
      if (res.status !== 429 && res.status !== 503) break;
      const hinted = Number(json.error?.message?.match(/retry in ([\d.]+)s/i)?.[1] ?? 0);
      await new Promise((r) => setTimeout(r, (hinted > 0 ? hinted + 1 : 8 * (attempt + 1)) * 1000));
    }
    if (!res || !res.ok || json.error) throw new Error(`gemini: ${json.error?.message ?? res?.status}`);
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const content: Block[] = [];
    let n = 0;
    for (const p of parts) {
      if (p.text) content.push({ type: "text", text: p.text, signature: p.thoughtSignature });
      if (p.functionCall) content.push({ type: "tool_use", id: `${p.functionCall.name}#${n++}`, name: p.functionCall.name, input: p.functionCall.args ?? {}, signature: p.thoughtSignature });
    }
    return { content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  };
}

/** Gemini rejects JSON-schema keys it does not know ($schema, additionalProperties, …). */
function stripSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (["$schema", "additionalProperties", "default", "examples", "title"].includes(k)) continue;
      out[k] = stripSchema(v);
    }
    return out;
  }
  return schema;
}

export interface Provider {
  api: MessagesApi;
  model: string;
  /** How much of each tool result the model gets to see. Sized to the provider's context and rate limits. */
  toolResultChars: number;
}

/**
 * Pick the provider from the environment: Gemini, then Groq, then Anthropic. AGENT_MODEL overrides
 * the model, AGENT_TOOL_RESULT_CHARS the per-result budget. Gemini's window is large and its free
 * tier is generous, so it sees whole schemas; Groq's free tier meters 8k tokens per minute, so it
 * gets a slice.
 */
export function messagesFromEnv(): Provider {
  const override = process.env.AGENT_TOOL_RESULT_CHARS ? Number(process.env.AGENT_TOOL_RESULT_CHARS) : undefined;
  if (process.env.GEMINI_API_KEY) return { api: geminiMessages(process.env.GEMINI_API_KEY), model: process.env.AGENT_MODEL ?? "gemini-flash-latest", toolResultChars: override ?? 120_000 };
  if (process.env.GROQ_API_KEY) return { api: groqMessages(process.env.GROQ_API_KEY), model: process.env.AGENT_MODEL ?? "openai/gpt-oss-120b", toolResultChars: override ?? 4_000 };
  if (process.env.ANTHROPIC_API_KEY) return { api: anthropicMessages(process.env.ANTHROPIC_API_KEY), model: process.env.AGENT_MODEL ?? "claude-sonnet-5", toolResultChars: override ?? 60_000 };
  throw new Error("set GEMINI_API_KEY, GROQ_API_KEY or ANTHROPIC_API_KEY");
}

const toApiTool = (t: McpTool) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema });

/** The tool-use loop: the model picks MCP tools until it answers. Bounded so a bad day costs little. */
export async function explore(question: string, mcp: SubgraphMcp, messages: MessagesApi, model: string, maxSteps = 8, toolResultChars = 60_000): Promise<ExploreResult> {
  const history: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: question }];
  const steps: ExploreStep[] = [];
  const tools = mcp.tools
    .filter((t) => ["search_subgraphs_by_keyword", "get_schema_by_subgraph_id", "execute_query_by_subgraph_id", "get_top_subgraph_deployments", "get_deployment_30day_query_counts"].includes(t.name))
    .map(toApiTool);
  for (let i = 0; i <= maxSteps; i++) {
    const res = await messages({ model, max_tokens: 1500, system: SYSTEM, tools, messages: history });
    history.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0 || i === maxSteps) {
      const answer = res.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
      return { question, answer: answer || "(no answer)", steps, model };
    }
    const results: ToolResult[] = [];
    for (const u of uses) {
      const output = await mcp.call(u.name, u.input);
      steps.push({ tool: u.name, input: u.input, output });
      results.push({ type: "tool_result", tool_use_id: u.id, content: output.slice(0, toolResultChars) });
    }
    history.push({ role: "user", content: results });
  }
  return { question, answer: "(no answer)", steps, model };
}

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
}

if (process.argv[1] && process.argv[1].endsWith("explore.ts")) {
  const question = process.argv.slice(2).join(" ") || "Which subgraphs index Aave v3 on Ethereum mainnet, and what is the total number of markets in the most used one?";
  const mcp = await connectSubgraphMcp(env("GRAPH_API_KEY"));
  console.log(`subgraph-mcp: ${mcp.tools.length} tools\nQ: ${question}\n`);
  try {
    const provider = messagesFromEnv();
    const r = await explore(question, mcp, provider.api, provider.model, 8, provider.toolResultChars);
    for (const s of r.steps) console.log(`  [${s.tool}] ${JSON.stringify(s.input).slice(0, 160)}\n    -> ${s.output.replace(/\s+/g, " ").slice(0, 220)}`);
    console.log(`\nA (${r.model}): ${r.answer}`);
  } finally {
    await mcp.close();
  }
}
