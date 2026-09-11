/**
 * The structured run log. Every tool call, model statement, decision, refusal, alert and chain
 * verdict lands here in order, and one run becomes one JSON file plus one Markdown rendering under
 * agent/out (gitignored). This is the demo transcript: what the agent saw, what it decided, what it
 * tried, and what the chain said.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type EntryKind = "tool" | "model" | "decision" | "refusal" | "chain" | "alert" | "payment" | "action" | "finding" | "verdict" | "note";

export interface Entry {
  seq: number;
  at: string;
  kind: EntryKind;
  title: string;
  data?: Record<string, unknown>;
}

const jsonSafe = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? `0x${Buffer.from(v).toString("hex")}` : v);

export class RunLog {
  readonly id: string;
  readonly entries: Entry[] = [];
  /** Print each entry as it is added. */
  echo: boolean;
  /**
   * Called with each entry the moment it is added: the live stream hooks here (GAP 3). A listener
   * that throws never reaches the run; the entry is already recorded.
   */
  onEntry?: (entry: Entry) => void;

  constructor(id?: string, echo = true) {
    this.id = id ?? new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    this.echo = echo;
  }

  add(kind: EntryKind, title: string, data?: Record<string, unknown>): Entry {
    const entry: Entry = { seq: this.entries.length + 1, at: new Date().toISOString(), kind, title, data };
    this.entries.push(entry);
    if (this.onEntry) {
      try {
        this.onEntry(entry);
      } catch {
        /* the stream is a spectator; the run does not depend on it */
      }
    }
    if (this.echo) {
      const detail = data ? " " + JSON.stringify(data, jsonSafe).slice(0, 320) : "";
      console.log(`  [${String(entry.seq).padStart(3)}] ${kind.padEnd(8)} ${title}${detail}`);
    }
    return entry;
  }

  of(kind: EntryKind): Entry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  toJSON() {
    return { id: this.id, entries: this.entries };
  }

  toMarkdown(): string {
    const lines = [`# run ${this.id}`, "", "| # | at | kind | what | detail |", "|---|---|---|---|---|"];
    for (const e of this.entries) {
      const detail = e.data ? JSON.stringify(e.data, jsonSafe).replace(/\|/g, "\\|").slice(0, 600) : "";
      lines.push(`| ${e.seq} | ${e.at.slice(11, 19)} | ${e.kind} | ${e.title.replace(/\|/g, "\\|")} | \`${detail}\` |`);
    }
    const refusals = this.of("refusal");
    const chain = this.of("chain");
    lines.push("", `## refusals (${refusals.length})`, "");
    for (const r of refusals) lines.push(`- ${r.title} ${r.data ? JSON.stringify(r.data, jsonSafe).slice(0, 300) : ""}`);
    lines.push("", `## chain verdicts (${chain.length})`, "");
    for (const c of chain) lines.push(`- ${c.title} ${c.data ? JSON.stringify(c.data, jsonSafe).slice(0, 300) : ""}`);
    return lines.join("\n") + "\n";
  }

  write(dir: string, name = this.id): { json: string; md: string } {
    fs.mkdirSync(dir, { recursive: true });
    const json = path.join(dir, `${name}.json`);
    const md = path.join(dir, `${name}.md`);
    fs.writeFileSync(json, JSON.stringify(this.toJSON(), jsonSafe, 2));
    fs.writeFileSync(md, this.toMarkdown());
    return { json, md };
  }
}

export const stringify = (v: unknown, space?: number) => JSON.stringify(v, jsonSafe, space);
