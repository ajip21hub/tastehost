import "server-only";
import { CATEGORIES } from "./categories";
import { recommendPlaces, searchEntity, type Counter } from "./qloo";
import type {
  CategoryKey, DataSource, Member, Plan, PlanPick, ResolvedMember, ScoredPlace,
} from "./types";

/** Run async jobs with a small concurrency cap (keeps Qloo rate limits happy). */
export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function worst(sources: DataSource[]): DataSource {
  if (sources.includes("fallback")) return "fallback";
  if (sources.includes("live")) return "live";
  return "cache";
}

/** A member "strongly fits" a place when it is roughly in their personal top third. */
export const STRONG_FIT = 0.7;

// ---- Tool 1: resolve each member's loves into Qloo entities ----------------
export async function resolveMembers(members: Member[], counter: Counter, city?: string) {
  const sources: DataSource[] = [];
  const resolved: ResolvedMember[] = await pool(members, 2, async (m) => {
    const loves = m.loves.map((l) => l.trim()).filter(Boolean).slice(0, 6);
    const found = await pool(loves, 3, (l) => searchEntity(l, counter, city));
    found.forEach((f) => sources.push(f.source));
    return {
      name: m.name.trim() || "Guest",
      entities: found.map((f) => f.entity).filter((e): e is NonNullable<typeof e> => Boolean(e)),
      unresolved: loves.filter((_, i) => !found[i].entity),
    };
  });
  return { resolved, source: worst(sources) };
}

// ---- Tool 2: shared taste across the group ---------------------------------
export function sharedTaste(resolved: ResolvedMember[]) {
  const byTag = new Map<string, { tag: string; members: Set<string> }>();
  for (const m of resolved)
    for (const e of m.entities)
      for (const t of e.tags) {
        const k = t.toLowerCase();
        if (!byTag.has(k)) byTag.set(k, { tag: t, members: new Set() });
        byTag.get(k)!.members.add(m.name);
      }
  return [...byTag.values()]
    .map((x) => ({ tag: x.tag, members: [...x.members] }))
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, 12);
}

// ---- Tool 3: group-fair place ranking for one category ----------------------
export async function rankCategory(
  resolved: ResolvedMember[], city: string, category: CategoryKey, counter: Counter,
): Promise<{ places: ScoredPlace[]; source: DataSource }> {
  const allIds = resolved.flatMap((m) => m.entities.map((e) => e.id));
  const allTags = resolved.flatMap((m) => m.entities.flatMap((e) => e.tags));
  const group = await recommendPlaces({ entityIds: allIds, city, category, take: 20, tasteTags: allTags }, counter);
  const per = await pool(resolved, 3, (m) =>
    recommendPlaces(
      { entityIds: m.entities.map((e) => e.id), city, category, take: 25, tasteTags: m.entities.flatMap((e) => e.tags) },
      counter,
    ),
  );

  const candidates = new Map(group.places.map((p) => [p.id, p]));
  per.forEach((r) => r.places.slice(0, 6).forEach((p) => !candidates.has(p.id) && candidates.set(p.id, p)));
  const groupRank = new Map(group.places.map((p, i) => [p.id, i]));

  const scored: ScoredPlace[] = [...candidates.values()].map((p) => {
    const memberFit: ScoredPlace["memberFit"] = {};
    resolved.forEach((m, mi) => {
      const list = per[mi].places;
      const rank = list.findIndex((x) => x.id === p.id);
      const tasteTags = new Set(m.entities.flatMap((e) => e.tags.map((t) => t.toLowerCase())));
      const tagHits = p.tags.filter((t) => tasteTags.has(t.toLowerCase()));
      const reasons: string[] = [];
      let s: number;
      if (rank >= 0) {
        s = 0.35 + 0.65 * (1 - rank / Math.max(list.length, 1));
        const anchors = m.entities.slice(0, 2).map((e) => e.name).join(" & ");
        reasons.push(`#${rank + 1} of ${list.length} for fans of ${anchors || "their picks"}`);
      } else {
        s = 0.2 + Math.min(0.25, tagHits.length * 0.08);
      }
      if (tagHits.length) reasons.push(`matches their taste for ${tagHits.slice(0, 3).join(", ")}`);
      memberFit[m.name] = { score: Math.round(s * 100) / 100, reasons };
    });
    const scores = Object.values(memberFit).map((x) => x.score);
    const avg = scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
    const min = Math.min(...scores);
    const gr = groupRank.get(p.id);
    const groupBoost = gr === undefined ? 0 : 1 - gr / Math.max(group.places.length, 1);
    const groupScore = 0.4 * avg + 0.4 * min + 0.2 * groupBoost;
    return { ...p, category, groupScore: Math.round(groupScore * 100) / 100, fairness: Math.round((min / (avg || 1)) * 100) / 100, memberFit };
  });

  scored.sort((a, b) => b.groupScore - a.groupScore);
  return { places: scored.slice(0, 8), source: worst([group.source, ...per.map((x) => x.source)]) };
}

// ---- Deterministic explanation (used when no LLM key is configured) --------
export function explainPick(place: ScoredPlace, resolved: ResolvedMember[]): Pick<PlanPick, "why" | "perMember"> {
  const perMember: Record<string, string> = {};
  for (const m of resolved) {
    const fit = place.memberFit[m.name];
    perMember[m.name] = fit?.reasons.length
      ? fit.reasons.join("; ")
      : `a safe compromise — not in ${m.name}'s top list, but the group signal ranks it highly`;
  }
  const label = CATEGORIES[place.category].label.toLowerCase();
  const fans = Object.entries(place.memberFit).filter(([, f]) => f.score >= STRONG_FIT).map(([n]) => n);
  const why =
    fans.length === resolved.length
      ? `Every member's own taste profile ranks ${place.name} near the top for ${label} — the strongest overlap Qloo found.`
      : `Best balance for ${label}: strong for ${fans.join(", ") || "the group as a whole"} while staying acceptable for everyone (fairness ${Math.round(place.fairness * 100)}%).`;
  const isSample = place.id.startsWith("sample:");
  return { why: isSample ? `${why.replace(" — the strongest overlap Qloo found", "")} (Sample data: Qloo was unreachable.)` : why, perMember };
}

export function buildPlan(args: {
  city: string; occasion: string; resolved: ResolvedMember[];
  ranked: Partial<Record<CategoryKey, ScoredPlace[]>>;
  chosen?: Partial<Record<CategoryKey, { placeId: string; why?: string; perMember?: Record<string, string> }>>;
  title?: string; summary?: string; previousPickIds?: string[];
}): Plan {
  const picks: PlanPick[] = [];
  for (const [cat, list] of Object.entries(args.ranked) as [CategoryKey, ScoredPlace[]][]) {
    if (!list?.length) continue;
    const wanted = args.chosen?.[cat];
    const chosenPlace = wanted && list.find((p) => p.id === wanted.placeId);
    // Ignore LLM text if it picked an ID that rank_places never returned (hallucination guard).
    const choice = chosenPlace ? wanted : undefined;
    const place = chosenPlace || list[0];
    const det = explainPick(place, args.resolved);
    const status = args.previousPickIds?.length ? (args.previousPickIds.includes(place.id) ? "kept" : "new") : undefined;
    picks.push({
      category: cat, place,
      why: choice?.why || det.why,
      perMember: { ...det.perMember, ...(choice?.perMember || {}) },
      status,
    });
  }
  const names = args.resolved.map((m) => m.name);
  return {
    title: args.title || `${args.occasion || "Group outing"} in ${args.city}`,
    summary:
      args.summary ||
      `A ${picks.length}-stop plan for ${names.join(", ")} built from Qloo's taste graph: each stop is ranked against every member's own taste profile, then picked for the best group-wide fit, not just popularity.`,
    city: args.city,
    sharedTaste: sharedTaste(args.resolved),
    picks,
    alternatives: Object.fromEntries(
      Object.entries(args.ranked).map(([k, v]) => [k, (v || []).filter((p) => !picks.some((x) => x.place.id === p.id)).slice(0, 3)]),
    ),
  };
}
