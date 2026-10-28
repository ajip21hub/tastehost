import { connection } from "next/server";
import { warmPlan } from "@/lib/agent";
import { PRESETS } from "@/lib/presets";

export const maxDuration = 120;

/** Warm the server-side plan cache for the one-click demo groups (sequential, so the AI quota isn't burst). */
export async function GET(request: Request) {
  await connection();
  const only = new URL(request.url).searchParams.get("id");
  const results: Record<string, string> = {};
  for (const p of PRESETS.filter((x) => !only || x.id === only)) {
    try {
      results[p.id] = await warmPlan({ city: p.city, occasion: p.occasion, members: p.members, categories: p.categories });
    } catch (e) {
      results[p.id] = `error: ${(e as Error).message.slice(0, 80)}`;
    }
  }
  return Response.json({ results });
}
