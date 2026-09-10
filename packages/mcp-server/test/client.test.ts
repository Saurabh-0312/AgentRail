import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "../src/server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A real MCP client spawns the server over stdio, exactly as Claude Desktop or Cursor would. */
describe("a real MCP client", () => {
  it("connects over stdio and lists the four tools with their schemas", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(here, "../src/index.ts")],
      cwd: path.join(here, ".."),
      env: { ...process.env, GRAPH_API_KEY: process.env.GRAPH_API_KEY ?? "unused-in-this-test" } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "agentrail-test-client", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([...TOOL_NAMES].sort());
      const check = tools.find((t) => t.name === "check_permission")!;
      expect(check.description).toMatch(/read-only/i);
      const props = (check.inputSchema as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {};
      expect(Object.keys(props).sort()).toEqual(["amount", "chain", "name", "payee"]);
      const history = tools.find((t) => t.name === "get_history")!;
      expect(Object.keys((history.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).toContain("blockedOnly");
    } finally {
      await client.close();
    }
  });
});
