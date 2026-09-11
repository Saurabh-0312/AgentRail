/**
 * The risk monitor: the loop from SPEC §7.2. One question, continuously: is Alice about to lose money?
 *
 *   getMyMandate        budget awareness first, from the fixed query (never the model)
 *   discovery pass      "which protocols is this wallet exposed to?"   natural language, Subgraph MCP
 *   drills              positions per lending protocol, approvals, outflows and balances
 *   prices              bought from the discovered feed through the mandate: the monitor is a customer
 *   own account         the delegated account's live delegate and recent outflows, from getMyMandate
 *   rules -> verdict    R1 / R2 / R3 as pure functions; severity is decided here, never by the model
 *
 * The verdict is a decision (severity, reasoning, recommended action). response.ts acts on it.
 * Nothing here hardcodes a protocol: the drills follow what the discovery pass found.
 *
 *   yarn workspace @agentrail/agent monitor [wallet]
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { respond } from "./response.ts";
import { fromMandateView, parseApprovals, parsePositions, parseProtocols, parseTransfers, priceInUSD, type DiscoveredProtocol } from "./rules/adapt.ts";
import { correlate, runRules, type Finding, type RiskData, type Verdict } from "./rules/index.ts";
import { createRuntime } from "./runtime.ts";
import type { AgentTools, MandateView, PaymentOutcome } from "./tools.ts";
import { RunLog } from "./transcript.ts";

export interface MonitorConfig {
  /** The wallet the monitor watches (EVM mainnet address). */
  wallet: string;
  walletChain?: string;
  tools: AgentTools;
  log: RunLog;
  /** unix seconds */
  now?: () => number;
  /** ENS name of the price feed to buy from; null skips the purchase. */
  feedService?: string | null;
  priceSymbols?: string[];
  /** How many lending protocols get a positions drill. */
  maxLendingDrills?: number;
  /** Spenders Alice trusts on the delegated account (the mandate PDA). */
  knownSpenders?: string[];
  /** Alice's Solana wallet, the owner of the delegated account. */
  ownerWallet?: string;
  windowSec?: number;
  /**
   * Run the positions, approvals and outflow drills concurrently. Each is an independent explore
   * loop of a minute or more; a browser-triggered run on a serverless function has a hard ceiling
   * and the log keeps every entry in order either way. Off by default: the CLI stays sequential.
   */
  parallelDrills?: boolean;
}

export interface Drill {
  name: string;
  question: string;
  answer: string;
  /** Rows the parser accepted. */
  parsed: number;
  tried?: string[];
}

export interface MonitorReport {
  wallet: string;
  mandate: MandateView;
  protocols: DiscoveredProtocol[];
  drills: Drill[];
  purchase?: PaymentOutcome;
  prices?: Record<string, number>;
  data: RiskData;
  findings: Finding[];
  verdict: Verdict;
  notes: string[];
}

const iso = (t: number) => new Date(t * 1000).toISOString();

export function discoveryQuestion(wallet: string, chain: string): string {
  return `Which DeFi protocols does the wallet ${wallet.toLowerCase()} (${chain}) currently hold positions in: lending (Aave, Compound, Spark, Morpho), DEX liquidity (Uniswap, Curve, Balancer), staking (Lido, Rocket Pool) or others? Search published subgraphs and query each candidate for this exact account id (lower-case). Search by BROAD protocol family name ("aave", "uniswap", "compound"), never a specific version like "Aave V3": older versions hold most positions and a version-specific search misses them. Check at least two different protocol families before answering. Answer ONLY with JSON of this shape: {"protocols":[{"name":"Aave V3","kind":"lending|dex|staking|other","chain":"${chain}","subgraphId":"<id you queried>","evidence":"one line: what the query returned"}]}. Use an empty list when nothing was found, and add "tried":["<subgraph ids>"] listing what you checked.`;
}

export function positionsQuestion(wallet: string, p: DiscoveredProtocol): string {
  const where = p.subgraphId ? `subgraph ${p.subgraphId}` : "the most used subgraph for it";
  return `On ${p.name} (${where}), for account ${wallet.toLowerCase()}: what is the total collateral in USD, the total borrowed in USD, the health factor if the subgraph stores one, and the average liquidation threshold as a fraction 0..1 if available? Read the account's open positions (side, balance, market, token price). Answer ONLY with JSON: {"positions":[{"protocol":"${p.name}","chain":"${p.chain}","collateralUSD":number,"debtUSD":number,"healthFactor":number|null,"liquidationThreshold":number|null,"evidence":"one line"}]}. If the account has no position there, return an empty list.`;
}

export function approvalsQuestion(wallet: string, chain: string, now: number, windowSec: number): string {
  return `Find ERC-20 Approval events granted BY the wallet ${wallet.toLowerCase()} on ${chain} between ${iso(now - windowSec)} and ${iso(now)} (unix ${now - windowSec}..${now}). Search for a published subgraph that indexes token approvals (owner, spender, value, timestamp); if you find none, return an empty list. For each approval say whether the value is the maximum uint256 and, if the subgraph can tell, how many transactions the spender has been part of and whether it is a known protocol contract. Answer ONLY with JSON: {"approvals":[{"token":"0x..","tokenSymbol":"..","spender":"0x..","amount":"<raw integer>","unlimited":true|false,"timestamp":<unix>,"spenderTxCount":<n or null>,"spenderKnown":true|false|null,"spenderLabel":".."}],"tried":["<subgraph ids you queried>"]}.`;
}

export function transfersQuestion(wallet: string, chain: string, now: number, windowSec: number): string {
  return `Find token transfers OUT of the wallet ${wallet.toLowerCase()} on ${chain} between ${iso(now - windowSec)} and ${iso(now)} (unix ${now - windowSec}..${now}), and the wallet's current balance of each token that moved. Use published subgraphs that index token transfers or balances; if none covers this wallet, return empty lists. Amounts in human units (not raw), with a USD value when the subgraph provides one. Answer ONLY with JSON: {"transfers":[{"token":"0x..","tokenSymbol":"..","amount":<number>,"amountUSD":<number or null>,"to":"0x..","timestamp":<unix>}],"balances":[{"token":"0x..","tokenSymbol":"..","amount":<number>,"amountUSD":<number or null>}],"tried":["<subgraph ids>"]}.`;
}

export async function runMonitor(cfg: MonitorConfig): Promise<MonitorReport> {
  const { tools, log } = cfg;
  const now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
  const t0 = now();
  const chain = cfg.walletChain ?? "eip155:1";
  const windowSec = cfg.windowSec ?? 86_400;
  const notes: string[] = [];
  const drills: Drill[] = [];
  log.add("note", `monitor: is ${cfg.wallet} about to lose money?`, { chain, window: `${windowSec / 3600}h` });

  // 1. budget awareness: the fixed query, before anything is bought
  const mandate = await tools.getMyMandate();

  // 2. the discovery pass: the agent does not know which protocols to look at until it looks
  const discovery = await tools.querySubgraph(discoveryQuestion(cfg.wallet, chain));
  const protocols = parseProtocols(discovery.answer);
  drills.push({ name: "discovery", question: discovery.question, answer: discovery.answer, parsed: protocols.length });
  log.add("decision", `discovery pass: ${protocols.length} protocol(s) found`, { protocols: protocols.map((p) => `${p.name} [${p.kind}] ${p.subgraphId ?? ""}`) });
  if (protocols.length === 0) notes.push("The discovery pass found no positions for this wallet in the subgraphs it searched; lending and DEX rules have nothing to evaluate.");

  // 3. drills follow the discovery: positions for each lending protocol, then approvals and outflows
  const data: RiskData = { wallet: cfg.wallet, approvals: [], transfers: [], balances: [], positions: [] };
  const lending = protocols.filter((p) => p.kind === "lending").slice(0, cfg.maxLendingDrills ?? 2);
  const positionsDrill = async () => {
    const out: Drill[] = [];
    for (const p of lending) {
      const a = await tools.querySubgraph(positionsQuestion(cfg.wallet, p));
      const positions = parsePositions(a.answer, `mcp:${p.subgraphId ?? p.name}`);
      data.positions.push(...positions);
      out.push({ name: `positions:${p.name}`, question: a.question, answer: a.answer, parsed: positions.length });
    }
    return out;
  };
  const approvalsDrill = async () => {
    const ap = await tools.querySubgraph(approvalsQuestion(cfg.wallet, chain, t0, windowSec));
    const approvals = parseApprovals(ap.answer, cfg.wallet, chain, "mcp:approvals");
    data.approvals.push(...approvals.approvals);
    if (approvals.approvals.length === 0) notes.push(`Approvals: none found in the window${approvals.tried.length ? ` (subgraphs tried: ${approvals.tried.join(", ")})` : ""}.`);
    return [{ name: "approvals", question: ap.question, answer: ap.answer, parsed: approvals.approvals.length, tried: approvals.tried }];
  };
  const transfersDrill = async () => {
    const tr = await tools.querySubgraph(transfersQuestion(cfg.wallet, chain, t0, windowSec));
    const transfers = parseTransfers(tr.answer, cfg.wallet, chain, "mcp:transfers");
    data.transfers.push(...transfers.transfers);
    data.balances.push(...transfers.balances);
    if (transfers.transfers.length === 0) notes.push(`Outflows: none found in the window${transfers.tried.length ? ` (subgraphs tried: ${transfers.tried.join(", ")})` : ""}.`);
    return [{ name: "transfers", question: tr.question, answer: tr.answer, parsed: transfers.transfers.length + transfers.balances.length, tried: transfers.tried }];
  };
  // the three drills are independent; the order of the report is fixed either way
  const drillResults = cfg.parallelDrills ? await Promise.all([positionsDrill(), approvalsDrill(), transfersDrill()]) : [await positionsDrill(), await approvalsDrill(), await transfersDrill()];
  for (const d of drillResults) drills.push(...d);

  // 4. prices, bought through the mandate from the discovered feed
  let purchase: PaymentOutcome | undefined;
  let prices: Record<string, number> | undefined;
  if (cfg.feedService) {
    // The feed meters per symbol, so the basket has to fit the mandate's per-transaction cap:
    // rail.allowed permits 30000 on Hedera and the feed charges 10000 each, so three is the ceiling.
    const symbols = cfg.priceSymbols ?? ["ETH", "SOL", "HBAR"];
    purchase = await tools.requestPayment({ service: cfg.feedService, symbols, reason: "USD valuation for the risk verdict" });
    if (purchase.status === "paid" && Array.isArray(purchase.data)) {
      prices = Object.fromEntries((purchase.data as { symbol: string; price: number }[]).filter((q) => q && typeof q.price === "number").map((q) => [q.symbol.toUpperCase(), q.price]));
      log.add("decision", `prices bought: ${Object.entries(prices).map(([s, p]) => `${s} ${p}`).join(", ")}`, { transactionId: purchase.transactionId });
      data.transfers = priceInUSD(data.transfers, prices);
      data.balances = priceInUSD(data.balances, prices);
    } else {
      notes.push(`Prices were not bought (${purchase.status}${purchase.reason ? `: ${purchase.reason}` : ""}); USD values come only from the subgraphs.`);
    }
  }

  // 5. the account the agent is actually delegated on: live delegate and recent outflows
  const own = fromMandateView(mandate, { now: t0, ownerWallet: cfg.ownerWallet ?? mandate.solana?.mandate ?? "owner", windowSec });
  data.approvals.push(...own.approvals);
  data.transfers.push(...own.transfers);
  data.balances.push(...own.balances);
  if (own.approvals.length) log.add("finding", `delegated account: delegate is not the mandate`, { delegate: own.approvals[0].spender, amount: own.approvals[0].amount, delegateTxCount: own.approvals[0].spenderHistory?.txCount ?? null });

  // 6. the rules decide; the verdict is the decision
  const findings = runRules(data, { now: t0, r1: { windowSec, knownSpenders: new Set((cfg.knownSpenders ?? []).map((s) => s.toLowerCase())) }, r2: { windowSec } });
  for (const f of findings) log.add("finding", `${f.rule} ${f.severity}: ${f.title}`, { evidence: f.evidence });
  const verdict = correlate(cfg.wallet, findings, { protocols: protocols.map((p) => p.name), dataNotes: notes });
  log.add("verdict", `${verdict.severity}: ${verdict.reasoning}`, { recommendedAction: verdict.recommendedAction });
  return { wallet: cfg.wallet, mandate, protocols, drills, purchase, prices, data, findings, verdict, notes };
}

// ---- CLI ---------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(here, "../out");

if (process.argv[1] && process.argv[1].endsWith("monitor.ts")) {
  const wallet = process.argv[2] ?? process.env.ALICE_WALLET;
  if (!wallet) throw new Error("ALICE_WALLET missing (or pass the wallet as the first argument)");
  const log = new RunLog(`monitor_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  const rt = await createRuntime({ log });
  try {
    const report = await runMonitor({ wallet, tools: rt.tools, log, feedService: rt.feedService, knownSpenders: [rt.solana.mandate], ownerWallet: rt.solana.owner });
    const response = await respond(report.verdict, { tools: rt.tools, alert: rt.alert, log });
    const files = log.write(OUT_DIR);
    console.log(`\nverdict ${report.verdict.severity}: ${report.verdict.reasoning}`);
    if (response.alert) console.log(`alert   ${response.alert.channel} ${response.alert.id} ${response.alert.explorer ?? ""}`);
    if (response.protective) console.log(`action  ${response.protective.action.instruction}: ${response.protective.outcome.status} ${response.protective.outcome.explorer ?? response.protective.outcome.reason ?? ""}`);
    if (response.warning) console.log(`warning ${response.warning}`);
    console.log(`transcript ${files.md}`);
  } finally {
    await rt.close();
  }
}
