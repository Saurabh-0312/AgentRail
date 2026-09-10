/**
 * The Subgraph MCP: exploratory, natural-language access to subgraphs published by other people
 * (SPEC §8.7: EXPLORING external data -> natural language; READING our own index -> a fixed query;
 * ENFORCING the mandate -> on-chain only). Our own Studio deployments are never reached through
 * this client; `@agentrail/query` reads them with one fixed query.
 *
 * Transport: SSE to subgraphs.mcp.thegraph.com with a Graph API key (Phase 0, spike 8).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export const SUBGRAPH_MCP_URL = "https://subgraphs.mcp.thegraph.com/sse";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface SubgraphMcp {
  tools: McpTool[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** Connect and list the server's tools (nine, as of subgraph-mcp 0.1.1). */
export async function connectSubgraphMcp(apiKey: string, url = SUBGRAPH_MCP_URL): Promise<SubgraphMcp> {
  const withAuth = (init?: RequestInit): RequestInit => {
    const headers = new Headers(init?.headers ?? undefined);
    headers.set("Authorization", `Bearer ${apiKey}`);
    return { ...init, headers };
  };
  const transport = new SSEClientTransport(new URL(url), {
    eventSourceInit: { fetch: (u, init) => fetch(u, withAuth(init as RequestInit)) },
    requestInit: withAuth({}),
  });
  const client = new Client({ name: "agentrail-agent", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })),
    async call(name, args) {
      // a failed tool call is information for the model (a wrong field, a dead subgraph), not a crash
      try {
        const res = await client.callTool({ name, arguments: args });
        const content = (res.content as { type: string; text?: string }[] | undefined) ?? [];
        const text = content.map((c) => c.text ?? "").join("\n");
        return res.isError ? `ERROR: ${text}` : text;
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    close: () => client.close(),
  };
}
