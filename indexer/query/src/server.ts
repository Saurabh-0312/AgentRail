/**
 * A GraphQL endpoint over the shared schema whose `mandates(where: { ensNode })` field fans out to
 * the three sources and returns their rows as one list. The schema is indexer/schema.graphql
 * verbatim (the subgraph directives are declared so graphql-js accepts them); the only addition is
 * the root Query type.
 *
 *   POST /graphql   { query, variables }
 *   GET  /          the fixed query and the three sources
 *
 * Run: yarn workspace @agentrail/query serve   (PORT, SUBGRAPH_SEPOLIA_URL, SUBGRAPH_BASE_URL, GRAPH_API_KEY)
 */
import { serve } from "@hono/node-server";
import { buildSchema, graphql } from "graphql";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { HISTORY_QUERY, fetchHistory, type HistoryConfig, type Mandate } from "./history.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_SCHEMA = fs.readFileSync(path.resolve(here, "../../schema.graphql"), "utf8");

/** The shared schema plus what graphql-js needs to parse subgraph SDL, plus the root query. */
export const SDL = `
scalar Bytes
scalar BigInt
scalar BigDecimal
scalar Int8
scalar Timestamp
directive @entity(immutable: Boolean) on OBJECT
directive @derivedFrom(field: String!) on FIELD_DEFINITION
directive @aggregation(intervals: [String!], source: String!) on OBJECT
directive @aggregate(fn: String!, arg: String, cumulative: Boolean) on FIELD_DEFINITION

${SHARED_SCHEMA}

input Mandate_filter { ensNode: Bytes, chain: String }

type Source {
  chain: String!
  url: String!
  mandates: Int!
  actions: Int!
  error: String
}

type Query {
  """The same query on every source, rows concatenated. Sepolia + Base from Subgraph Studio, Solana from the Substreams stream."""
  mandates(where: Mandate_filter!): [Mandate!]!
  """What answered, and with how many rows."""
  sources(ensNode: Bytes!): [Source!]!
}
`;

export function createServer(cfg: HistoryConfig) {
  const schema = buildSchema(SDL);
  const rootValue = {
    mandates: async ({ where }: { where: { ensNode?: string; chain?: string } }): Promise<Mandate[]> => {
      if (!where.ensNode) throw new Error("where.ensNode is required: it is the join key");
      const r = await fetchHistory(where.ensNode, cfg);
      return where.chain ? r.mandates.filter((m) => m.chain === where.chain) : r.mandates;
    },
    sources: async ({ ensNode }: { ensNode: string }) => (await fetchHistory(ensNode, cfg)).sources,
  };
  const app = new Hono();
  app.get("/", (c) => c.json({ query: HISTORY_QUERY, sources: ["sepolia: " + cfg.sepoliaUrl, "base: " + cfg.baseUrl, "solana: substreams map_activity via devnet.sol.streamingfast.io:443 (solana-sink.ts)"], schema: "indexer/schema.graphql" }));
  app.post("/graphql", async (c) => {
    const { query, variables } = (await c.req.json()) as { query: string; variables?: Record<string, unknown> };
    const result = await graphql({ schema, source: query, rootValue, variableValues: variables });
    return c.json(result);
  });
  return app;
}

function env(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing`);
  return v;
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const app = createServer({ sepoliaUrl: env("SUBGRAPH_SEPOLIA_URL"), baseUrl: env("SUBGRAPH_BASE_URL"), apiKey: env("GRAPH_API_KEY") });
  const port = Number(process.env.PORT ?? 4030);
  serve({ fetch: app.fetch, port }, () => console.log(`agentrail shared-schema query on http://localhost:${port}/graphql`));
}
