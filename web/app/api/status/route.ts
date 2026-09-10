/** GET /api/status: one timed read per chain, the index heads, and whether the feed is awake. */
import { getStatus } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getStatus(), { headers: { "Cache-Control": "no-store" } });
}
