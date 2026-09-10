/**
 * stdio entry point. An MCP client spawns this process and talks JSON-RPC over stdin/stdout.
 *
 *   node --env-file=../../.env src/index.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { defaultDeps } from "./chains.ts";
import { createServer } from "./server.ts";

const server = createServer(defaultDeps(process.env));
await server.connect(new StdioServerTransport());
