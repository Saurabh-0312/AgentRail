import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { RunLog } from "@agentrail/agent/src/transcript.ts";

import { isBudgetRefusal, phaseAfter, RunLogView, type LiveEntry } from "../components/run-log";
import { parseSse } from "../components/activate-agent";
import { createRunLock } from "../lib/run-lock";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the mock monitor did, with wall-clock marks so the test can prove entries were not batched. */
const marks = { runs: 0, finishedAt: 0, runtimeNames: [] as string[] };

vi.mock("@agentrail/agent/src/runtime-agent.ts", () => ({
  createAgentRuntime: vi.fn(async ({ agentName, log }: { agentName: string; log: RunLog }) => {
    marks.runtimeNames.push(agentName);
    log.add("note", `${agentName}: rail.allowed has 3 payee(s)`);
    return {
      tools: {},
      feedService: "feed.agentrail.eth",
      solana: { mandate: "7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a", owner: "55FJao825sA7rR9aKNtUEuGzN2gQNN9nZBw41WCWjvwb" },
      rails: [{ chain: "hedera:testnet", state: "ready", detail: "mandate 0xe2d8" }],
      provider: { model: "test-model" },
      paidRequests: () => 1,
      close: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("@agentrail/agent/src/monitor.ts", () => ({
  runMonitor: vi.fn(async ({ log, wallet }: { log: RunLog; wallet: string }) => {
    marks.runs++;
    log.add("note", `monitor: is ${wallet} about to lose money?`);
    await sleep(40);
    log.add("tool", "getMyMandate (fixed query)", { chains: ["hedera:testnet: active"] });
    await sleep(40);
    log.add("refusal", "feed.agentrail.eth: mandate refused SpendLimitExceeded; paid requests sent: 0", { refusedBy: "evm-check", detail: "SpendLimitExceeded" });
    await sleep(40);
    log.add("verdict", "NONE: nothing abnormal", { recommendedAction: "none" });
    marks.finishedAt = Date.now();
    return { verdict: { severity: "NONE", reasoning: "nothing abnormal", recommendedAction: "none" }, protocols: [], purchase: { status: "refused", reason: "SpendLimitExceeded" } };
  }),
}));

// the attack and defend stages must be unreachable from the route; if it ever imported them, these spies would show it
vi.mock("@agentrail/agent/src/attack/run.ts", () => ({ runAttack: vi.fn(), createAttackRuntime: vi.fn() }));
vi.mock("@agentrail/agent/src/demo.ts", () => ({ demo: vi.fn() }));
vi.mock("@agentrail/agent/src/response.ts", () => ({ respond: vi.fn() }));

beforeAll(() => {
  vi.stubEnv("GRAPH_API_KEY", "test-key-not-real-1234567890");
});

interface Received {
  event: string;
  data: Record<string, unknown>;
  at: number;
}

/** Read an SSE response as it streams, stamping each event with its arrival time. */
async function collect(res: Response): Promise<Received[]> {
  const out: Received[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = parseSse(buffer);
    buffer = rest;
    for (const f of frames) out.push({ event: f.event, data: JSON.parse(f.data), at: Date.now() });
  }
  return out;
}

describe("the run route", () => {
  it("calls runMonitor and only runMonitor, for the name in the request", async () => {
    const { GET } = await import("../app/api/agent/run/route");
    const { runMonitor } = await import("@agentrail/agent/src/monitor.ts");
    const { runAttack } = await import("@agentrail/agent/src/attack/run.ts");
    const { respond } = await import("@agentrail/agent/src/response.ts");
    const res = await GET(new Request("http://x/api/agent/run?name=second.agentrail.eth&wallet=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", { headers: { "x-forwarded-for": "10.0.0.1" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const events = await collect(res);
    expect(vi.mocked(runMonitor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runMonitor).mock.calls[0][0]).toMatchObject({ wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", feedService: "feed.agentrail.eth", knownSpenders: ["7TuT4p76fPgGbxY6PHLVjJiX7aX4QUCiPX7TPYv6L69a"] });
    expect(marks.runtimeNames).toContain("second.agentrail.eth");
    expect(vi.mocked(runAttack)).not.toHaveBeenCalled();
    expect(vi.mocked(respond)).not.toHaveBeenCalled();
    // there is no mode parameter and no path to attack/defend in the source at all
    const src = fs.readFileSync(path.join(here, "../app/api/agent/run/route.ts"), "utf8");
    expect(src).not.toMatch(/from "@agentrail\/agent\/src\/(attack|demo|response)/);
    expect(src).not.toMatch(/runAttack|createAttackRuntime|respond\(|stageDrainer|searchParams\.get\("mode"\)/);
    expect(src).toMatch(/runMonitor\(/);
    expect(src).toMatch(/export const maxDuration = \d+/);
    expect(src).toMatch(/export const runtime = "nodejs"/);
    expect(events.map((e) => e.event)).toEqual(["start", "entry", "ready", "entry", "entry", "entry", "entry", "done"]);
  });

  it("streams every entry the moment it is added, in order, not batched at the end", async () => {
    const { GET } = await import("../app/api/agent/run/route");
    const res = await GET(new Request("http://x/api/agent/run", { headers: { "x-forwarded-for": "10.0.0.2" } }));
    const events = await collect(res);
    const entries = events.filter((e) => e.event === "entry");
    expect(entries.map((e) => (e.data as { seq: number }).seq)).toEqual([1, 2, 3, 4, 5]);
    // the first monitor entry reached the client well before the monitor finished (three 40 ms waits later)
    const firstMonitorEntry = entries.find((e) => String((e.data as { title: string }).title).startsWith("monitor:"))!;
    expect(firstMonitorEntry.at).toBeLessThan(marks.finishedAt - 60);
    const done = events[events.length - 1];
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ entries: 5, refusals: 1, toolCalls: 1, verdict: { severity: "NONE" } });
  });

  it("a refusal mid-run does not end the stream: the verdict and the done event still arrive", async () => {
    const { GET } = await import("../app/api/agent/run/route");
    const res = await GET(new Request("http://x/api/agent/run", { headers: { "x-forwarded-for": "10.0.0.3" } }));
    const events = await collect(res);
    const kinds = events.filter((e) => e.event === "entry").map((e) => (e.data as { kind: string }).kind);
    const refusalAt = kinds.indexOf("refusal");
    expect(refusalAt).toBeGreaterThan(-1);
    expect(kinds.slice(refusalAt + 1)).toContain("verdict");
    expect(events[events.length - 1].event).toBe("done");
  });

  it("refuses a second concurrent run with a sentence, and a repeat within the cooldown", async () => {
    const { GET } = await import("../app/api/agent/run/route");
    const first = GET(new Request("http://x/api/agent/run", { headers: { "x-forwarded-for": "10.0.0.4" } }));
    await sleep(10);
    const second = await GET(new Request("http://x/api/agent/run", { headers: { "x-forwarded-for": "10.0.0.5" } }));
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toMatch(/already in progress/);
    await collect(await first);
    const again = await GET(new Request("http://x/api/agent/run", { headers: { "x-forwarded-for": "10.0.0.4" } }));
    expect(again.status).toBe(429);
    expect(((await again.json()) as { error: string }).error).toMatch(/Wait \d+ s/);
  });

  it("rejects a malformed name or wallet before touching anything", async () => {
    const { GET } = await import("../app/api/agent/run/route");
    expect((await GET(new Request("http://x/api/agent/run?name=not%20a%20name"))).status).toBe(400);
    expect((await GET(new Request("http://x/api/agent/run?wallet=0x12"))).status).toBe(400);
  });
});

describe("the run lock", () => {
  it("is single-flight globally with a per-client cooldown", () => {
    const lock = createRunLock({ cooldownMs: 1000 });
    const a = lock.acquire("a", 0);
    expect(a.ok).toBe(true);
    expect(lock.acquire("b", 10)).toMatchObject({ ok: false, status: 429 });
    if (a.ok) a.release();
    expect(lock.acquire("a", 500)).toMatchObject({ ok: false, status: 429 });
    expect(lock.acquire("b", 500).ok).toBe(true);
  });
});

describe("the live log", () => {
  const entries: LiveEntry[] = [
    { seq: 1, at: "2026-09-11T10:00:00.000Z", kind: "tool", title: "getMyMandate (fixed query)" },
    { seq: 2, at: "2026-09-11T10:00:01.000Z", kind: "refusal", title: "feed.agentrail.eth: mandate refused SpendLimitExceeded; paid requests sent: 0", data: { refusedBy: "evm-check", detail: "SpendLimitExceeded" } },
    { seq: 3, at: "2026-09-11T10:00:02.000Z", kind: "payment", title: "  paid 30000 units -> 0.0.7162784@1789048137.267734703", data: { explorer: "https://hashscan.io/testnet/transaction/0.0.7162784-1789048137-267734703" } },
    { seq: 4, at: "2026-09-11T10:00:03.000Z", kind: "verdict", title: "NONE: nothing abnormal" },
  ];

  it("renders a refusal red and loud with its code, and the run keeps going after it", () => {
    const html = renderToStaticMarkup(createElement(RunLogView, { entries, status: "running", phase: "Running R1 / R2 / R3…" }));
    expect(html).toMatch(/<li[^>]*data-kind="refusal"[^>]*class="[^"]*text-blocked/);
    expect(html).toContain("REFUSED");
    expect(html).toContain("SpendLimitExceeded");
    expect(html).toMatch(/data-kind="verdict"/);
    expect(html).toContain('data-testid="phase"');
    // the thesis banner, because the refusal came from the mandate's own caps
    expect(html).toContain('data-testid="thesis"');
    expect(html).toContain("the demo budget is exhausted");
    expect(html).toContain("no money moved");
    expect(isBudgetRefusal(entries[1])).toBe(true);
    expect(isBudgetRefusal(entries[0])).toBe(false);
  });

  it("links a payment to its explorer and shows the ended-early state honestly", () => {
    const html = renderToStaticMarkup(createElement(RunLogView, { entries, status: "ended-early" }));
    expect(html).toContain("https://hashscan.io/testnet/transaction/0.0.7162784-1789048137-267734703");
    expect(html).toContain("Stream ended early");
    expect(html).toContain("4 steps completed");
  });

  it("guesses the next phase from the last entry and stops once the run is over", () => {
    expect(phaseAfter(undefined, "connecting")).toMatch(/Starting/);
    expect(phaseAfter(entries[0], "running")).toMatch(/Discovery pass/);
    expect(phaseAfter(entries[3], "done")).toBeNull();
  });

  it("parses SSE frames incrementally and drops keepalives", () => {
    const { frames, rest } = parseSse(': keepalive 1\n\nevent: entry\ndata: {"seq":1}\n\nevent: done\ndata: {"a":1}\n\nevent: ent');
    expect(frames).toEqual([{ event: "entry", data: '{"seq":1}' }, { event: "done", data: '{"a":1}' }]);
    expect(rest).toBe("event: ent");
  });
});

describe("secret isolation for the run", () => {
  it("the client components never read the environment; the route reads only server env", () => {
    for (const f of ["activate-agent.tsx", "run-log.tsx"]) expect(fs.readFileSync(path.join(here, "../components", f), "utf8")).not.toMatch(/process\.env|serverEnv|API_KEY|PRIVATE_KEY/);
    const example = fs.readFileSync(path.join(here, "../../.env.example"), "utf8");
    expect(example).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|PRIVATE|TOKEN)/);
  });
});
