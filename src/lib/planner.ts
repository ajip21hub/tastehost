import "server-only";
import { CATEGORIES } from "./categories";
import { affinityFor, recommendPlaces, searchEntity, type Counter } from "./qloo";
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
export const LEFT_OUT_PENALTY = 0.12;
const PER_MEMBER_TAKE = 40; // Qloo max take is 50; 40 keeps payloads fast

// ---- Tool 1: resolve each member's loves into Qloo entities ----------------
export async function resolveMembers(members: Member[], counter: Counter, city?: string) {
  const sources: DataSource[] = [];
  const resolved: ResolvedMember[] = await pool(members, 2, async (m) => {
    // 2 members x 2 favourites in flight = max 4 concurrent Qloo searches (avoids 429 bursts).
    const loves = m.loves.map((l) => l.trim()).filter(Boolean).slice(0, 6);
    const found = await pool(loves, 2, (l) => searchEntity(l, counter, city));
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
/**
 * 1. One Qloo Insights call for the whole group + one per member (top PER_MEMBER_TAKE places each).
 * 2. Score every candidate per member by their personal rank.
 * 3. For the 15 best candidates missing from someone's list, fetch that person's affinity for exactly those
 *    places (filter.results.entities) so "outside your top 40" places can still be compared (max-min fairness).
 * 4. Minimum-satisfaction rule: a place in the bottom third of anyone's list (or beyond it) "leaves them out";
 *    places leaving fewer people out always rank first, then by groupScore = 0.4·avg + 0.4·min + 0.2·group rank.
 */
export async function rankCategory(
  resolved: ResolvedMember[], city: string, category: CategoryKey, counter: Counter,
): Promise<{ places: ScoredPlace[]; source: DataSource }> {
  const allIds = resolved.flatMap((m) => m.entities.map((e) => e.id));
  const allTags = resolved.flatMap((m) => m.entities.flatMap((e) => e.tags));
  const group = await recommendPlaces({ entityIds: allIds, city, category, take: 20, tasteTags: allTags }, counter);
  const per = await pool(resolved, 3, (m) =>
    recommendPlaces(
      { entityIds: m.entities.map((e) => e.id), city, category, take: PER_MEMBER_TAKE, tasteTags: m.entities.flatMap((e) => e.tags) },
      counter,
    ),
  );

  const candidates = new Map(group.places.map((p) => [p.id, p]));
  per.forEach((r) => r.places.forEach((p) => !candidates.has(p.id) && candidates.set(p.id, p)));
  const groupRank = new Map(group.places.map((p, i) => [p.id, i]));
  // member index -> place id -> Qloo affinity (only for places missing from that member's list)
  const outsideAff: Map<string, number>[] = resolved.map(() => new Map());

  const score = (): ScoredPlace[] =>
    [...candidates.values()].map((p) => {
      const memberFit: ScoredPlace["memberFit"] = {};
      const leftOut: string[] = [];
      resolved.forEach((m, mi) => {
        const list = per[mi].places;
        const len = Math.max(list.length, 1);
        const idx = list.findIndex((x) => x.id === p.id);
        const rank = idx >= 0 ? idx + 1 : undefined;
        const tasteTags = new Set(m.entities.flatMap((e) => e.tags.map((t) => t.toLowerCase())));
        const tagHits = p.tags.filter((t) => tasteTags.has(t.toLowerCase()));
        const anchors = m.entities.slice(0, 2).map((e) => e.name).join(" & ") || "their picks";
        const reasons: string[] = [];
        let s: number;
        if (rank !== undefined && rank <= len) {
          s = 0.35 + 0.65 * (1 - (rank - 1) / len);
          reasons.push(`#${rank} of ${len} for fans of ${anchors}`);
        } else {
          // Outside their list: score 0–0.34 by how close their affinity is to the bottom of their list.
          const a = outsideAff[mi].get(p.id);
          const affs = list.map((x) => x.affinity);
          const hi = Math.max(...affs, 0), lo = Math.min(...affs, 1);
          const floor = lo - Math.max(hi - lo, 0.01);
          const closeness = a === undefined ? 0 : Math.max(0, Math.min(1, (a - floor) / (lo - floor || 1)));
          s = 0.1 + 0.24 * closeness + Math.min(0.06, tagHits.length * 0.02);
          reasons.push(`${closeness > 0.6 ? "just outside" : "outside"} their top ${len} for fans of ${anchors}`);
        }
        if (tagHits.length) reasons.push(`matches their taste for ${tagHits.slice(0, 3).join(", ")}`);
        memberFit[m.name] = { score: Math.round(s * 100) / 100, reasons, ...(rank !== undefined && rank <= len ? { rank, of: len } : {}) };
        if (rank === undefined || rank > Math.ceil((len * 2) / 3)) leftOut.push(m.name);
      });
      const scores = Object.values(memberFit).map((x) => x.score);
      const avg = scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
      const min = Math.min(...scores);
      const gr = groupRank.get(p.id);
      const groupBoost = gr === undefined ? 0 : 1 - gr / Math.max(group.places.length, 1);
      const groupScore = Math.max(0, 0.4 * avg + 0.4 * min + 0.2 * groupBoost - LEFT_OUT_PENALTY * leftOut.length);
      return { ...p, category, groupScore: Math.round(groupScore * 100) / 100, fairness: Math.round((min / (avg || 1)) * 100) / 100, memberFit, leftOut };
    }).sort((a, b) => a.leftOut.length - b.leftOut.length || b.groupScore - a.groupScore);

  let scored = score();
  const top = scored.slice(0, 15);
  if (top.some((p) => p.leftOut.length)) {
    await pool(resolved, 3, async (m, mi) => {
      const missing = top.filter((p) => !per[mi].places.some((x) => x.id === p.id)).map((p) => p.id);
      if (missing.length) outsideAff[mi] = await affinityFor(m.entities.map((e) => e.id), missing, counter);
    });
    scored = score();
  }
  if (process.env.TH_DEBUG)
    console.log(`[debug] ${category} ` + scored.slice(0, 5).map((p) => `${p.name} ${p.groupScore} out=${p.leftOut.join("/")} ${Object.entries(p.memberFit).map(([n, f]) => n + ":" + (f.rank ?? "-")).join(",")}`).join(" ;; "));
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
  const others = fans.filter((n) => !place.leftOut.includes(n));
  const why = place.leftOut.length
    ? `Best compromise for ${label}: strong for ${others.join(", ") || "most of the group"}, and the closest match Qloo found for ${place.leftOut.join(", ")} — no ${label} spot is in everyone's personal top list.`
    : fans.length === resolved.length
      ? `Every member's own taste profile ranks ${place.name} near the top for ${label} — the strongest overlap Qloo found.`
      : `Best balance for ${label}: strong for ${fans.join(", ") || "the group as a whole"} while staying in everyone's top two-thirds (fairness ${Math.round(place.fairness * 100)}%).`;
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
    // Fairness guard: if the LLM picked a place that leaves someone out while a pick exists that leaves
    // nobody out, use the fair one (and our grounded explanation) instead.
    const fairAlt = list.find((p) => p.leftOut.length === 0);
    const unfair = chosenPlace && chosenPlace.leftOut.length > 0 && fairAlt;
    const choice = chosenPlace && !unfair ? wanted : undefined;
    const place = (unfair ? fairAlt : chosenPlace) || list[0];
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
