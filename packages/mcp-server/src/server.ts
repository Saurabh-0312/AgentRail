/**
 * The MCP server: four read-only tools over the SDK, so any agent, in any MCP client, can ask
 * "what am I allowed to do?" before it asks the chain to do it. It never signs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { checkPermission, getHistory, getMandate, listServices, type Deps } from "./tools.ts";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] });
const failure = (e: unknown) => ({ content: [{ type: "text" as const, text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

export const TOOL_NAMES = ["get_mandate", "check_permission", "list_services", "get_history"] as const;

export function createServer(deps: Deps): McpServer {
  const server = new McpServer({ name: "agentrail", version: "0.1.0" });

  server.registerTool(
    "get_mandate",
    {
      title: "Read a mandate",
      description:
        "Resolve an ENS name through ENSv2 (Sepolia) and return what it carries: its rail.* records, the allow-list of payees and caps the owner published, and the live mandate on every chain it names (Solana devnet, Hedera testnet, Base Sepolia): active, expiry, permissions, spent. Works for any name; an unknown name comes back as kind \"unknown\".",
      inputSchema: { name: z.string().describe("ENS name, e.g. databot.agentrail.eth") },
    },
    async ({ name }) => {
      try {
        return text(await getMandate(deps, name));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "check_permission",
    {
      title: "Would this payment be permitted?",
      description:
        "Run the same two checks the SDK runs before any facilitator is contacted: is the payee on the agent's published allow-list for that chain, and does the live mandate permit the amount (a local mirror of the Solana program's checks, or EvmMandate.check on Hedera/Base). Read-only: the answer the gate would give, without signing or sending anything.",
      inputSchema: {
        name: z.string().describe("the agent's ENS name"),
        chain: z.enum(["solana:devnet", "hedera:testnet", "eip155:84532"]).describe("CAIP-2 chain id, as in the service's rail.chain"),
        payee: z.string().describe("the payee: a Solana wallet, a Hedera account id like 0.0.10440535, or an EVM address"),
        amount: z.string().describe("amount in the token's base units (USDC has 6 decimals on Solana and Hedera; The Graph charges 42 units per query on Base)"),
      },
    },
    async (input) => {
      try {
        return text(await checkPermission(deps, input));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List discoverable services",
      description: "The services an agent can discover by ENS name: rail.endpoint, rail.chain, rail.price, rail.token, rail.scheme, resolved from the name, plus which payees the agent's own allow-list permits on that chain. Defaults to the demo directory.",
      inputSchema: { names: z.array(z.string()).optional().describe("service ENS names; omit for the default directory") },
    },
    async ({ names }) => {
      try {
        return text(await listServices(deps, names));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "get_history",
    {
      title: "Read the mandate's history",
      description: "Everything the mandate did on every chain, from the shared index (one fixed GraphQL query over Subgraph Studio plus the Solana stream), newest first, refusals included with their error code. Pass blockedOnly to see only what was refused.",
      inputSchema: {
        name: z.string().optional().describe("the agent's ENS name (default: the demo agent)"),
        ensNode: z.string().optional().describe("or the namehash directly"),
        blockedOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional().describe("rows to return (default 100)"),
      },
    },
    async (input) => {
      try {
        return text(await getHistory(deps, input));
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
