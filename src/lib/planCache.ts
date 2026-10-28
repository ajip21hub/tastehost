import "server-only";
import { createHash } from "node:crypto";
import { cacheGet, cacheSet } from "./cache";
import type { AgentEvent, PlanRequest } from "./types";

/**
 * Cache of finished AI plans, keyed by a hash of the normalised group + city + occasion + categories.
 * Stored privately on the server (memory + temp dir, see cache.ts) — never in the repo, because plans
 * contain Qloo-derived place data. Preset demo groups are warmed at runtime via /api/warm.
 */
const TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface CachedRun { events: AgentEvent[]; createdAt: number }

export function planKey(req: PlanRequest) {
  const norm = {
    v: 2, // bump when plan format/scoring changes so stale plans aren't served
    city: req.city.trim().toLowerCase(),
    occasion: req.occasion.trim().toLowerCase(),
    categories: [...req.categories].sort(),
    members: req.members
      .map((m) => ({ name: m.name.trim().toLowerCase(), loves: m.loves.map((l) => l.trim().toLowerCase()).filter(Boolean).sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 24);
}

export async function getCachedRun(key: string) {
  return (await cacheGet<CachedRun>(`plan:${key}`, TTL_MS))?.value ?? null;
}

export async function putCachedRun(key: string, run: CachedRun) {
  await cacheSet(`plan:${key}`, run);
}
