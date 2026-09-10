/**
 * GET /api/history?ensNode=0x…   (defaults to the demo agent's node)
 *
 * The shared schema over three chains, merged on the server: both Studio endpoints are queried with
 * the Graph API key from the server environment, the Solana leg comes from the committed snapshot.
 * The browser never sees the key and never talks to Studio.
 */
import { PUBLIC } from "@/lib/env";
import { history } from "@/lib/history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ensNode = url.searchParams.get("ensNode") ?? PUBLIC.ensNode;
  if (!/^0x[0-9a-fA-F]{64}$/.test(ensNode)) return Response.json({ error: "ensNode must be a bytes32 hex string" }, { status: 400 });
  try {
    const payload = await history(ensNode);
    return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
