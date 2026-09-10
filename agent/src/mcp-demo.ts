/**
 * The Subgraph MCP without a model in the loop: the same three tools an LLM would chain
 * (search -> schema -> query) run deterministically for one keyword, so the wiring can be checked
 * and shown without an API key for a model. `explore.ts` is the natural-language version.
 *
 *   yarn workspace @agentrail/agent mcp:demo [keyword] [entity]
 *
 * Reads only published, third-party subgraphs through the Gateway; never our own Studio index.
 */
import { connectSubgraphMcp } from "./mcp.ts";

const keyword = process.argv[2] ?? "aave";
const entityHint = process.argv[3];
const apiKey = process.env.GRAPH_API_KEY;
if (!apiKey) throw new Error("GRAPH_API_KEY missing");

interface SearchResult {
  subgraphs?: { id: string; metadata?: { displayName?: string }; currentVersion?: { subgraphDeployment?: { ipfsHash?: string } } }[];
}

const mcp = await connectSubgraphMcp(apiKey);
try {
  console.log(`subgraph-mcp: ${mcp.tools.length} tools\n1) search_subgraphs_by_keyword("${keyword}")`);
  const found = JSON.parse(await mcp.call("search_subgraphs_by_keyword", { keyword })) as SearchResult;
  const candidates = found.subgraphs ?? [];
  console.log(`   ${candidates.length} subgraphs: ${candidates.slice(0, 5).map((s) => `${s.metadata?.displayName ?? "?"} (${s.id.slice(0, 8)}…)`).join(" · ")}`);

  // the first one whose schema resolves (some entries have no current version)
  let id = "";
  let schema = "";
  for (const s of candidates.slice(0, 5)) {
    const out = await mcp.call("get_schema_by_subgraph_id", { subgraph_id: s.id }).catch((e) => `ERROR: ${String(e)}`);
    if (!out.startsWith("ERROR")) {
      id = s.id;
      schema = out;
      console.log(`\n2) get_schema_by_subgraph_id(${id})  [${s.metadata?.displayName}]`);
      break;
    }
  }
  if (!id) throw new Error("no candidate has a resolvable schema");
  const entities = [...schema.matchAll(/^type\s+(\w+)\s+@entity/gm)].map((m) => m[1]);
  console.log(`   ${entities.length} entities: ${entities.slice(0, 12).join(", ")}${entities.length > 12 ? ", …" : ""}`);
  const entity = entityHint && entities.includes(entityHint) ? entityHint : entities[0];
  if (!entity) throw new Error("schema has no entities");
  const plural = entity.charAt(0).toLowerCase() + entity.slice(1) + "s";
  const body = schema.match(new RegExp(`type\\s+${entity}\\s+@entity[^{]*\\{([^}]*)\\}`))?.[1] ?? "";
  const fields = [...body.matchAll(/^\s*(\w+):\s*([\w!\[\]]+)/gm)]
    .filter((m) => /^(ID|String|Bytes|BigInt|BigDecimal|Int|Boolean)!?$/.test(m[2]))
    .map((m) => m[1])
    .slice(0, 5);
  const query = `{ ${plural}(first: 3) { ${fields.join(" ")} } }`;

  console.log(`\n3) execute_query_by_subgraph_id(${id}) ${query}`);
  const result = await mcp.call("execute_query_by_subgraph_id", { subgraph_id: id, query });
  console.log(result.slice(0, 1200));
} finally {
  await mcp.close();
}
