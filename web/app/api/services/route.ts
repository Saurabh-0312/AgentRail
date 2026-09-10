/** GET /api/services: the directory, resolved from ENS on every request. */
import { getServices } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getServices(), { headers: { "Cache-Control": "no-store" } });
}
