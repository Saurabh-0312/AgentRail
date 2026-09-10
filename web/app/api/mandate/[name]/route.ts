/**
 * GET /api/mandate/<ens name>
 *
 * Resolves a name through ENSv2 on Sepolia, classifies it (agent, service, unknown) from the
 * records that came back, and for an agent reads the live mandate on every chain it names. Works
 * for any name; an unknown one returns an honest empty shape, not an error.
 */
import { getMandatePayload } from "@/lib/agent-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const payload = await getMandatePayload(decodeURIComponent(name));
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
