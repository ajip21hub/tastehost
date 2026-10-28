import "server-only";
import { cacheGet, cacheSet } from "./cache";
import { CATEGORIES } from "./categories";
import { fallbackPlaces, fallbackSearch } from "./fallback";
import type { CategoryKey, DataSource, Place, TasteEntity } from "./types";

const BASE = (process.env.QLOO_API_URL || "https://hackathon.api.qloo.com").replace(/\/$/, "");
const FRESH_MS = 1000 * 60 * 60 * 24; // 24h
const STALE_MS = 1000 * 60 * 60 * 24 * 30; // serve stale cache up to 30 days if Qloo is down
const TIMEOUT_MS = Number(process.env.QLOO_TIMEOUT_MS || 12000);
const ATTEMPTS = 3;

export function qlooConfigured() {
  return Boolean(process.env.QLOO_API_KEY);
}

export type Counter = Record<DataSource, number>;
export const newCounter = (): Counter => ({ live: 0, cache: 0, fallback: 0 });

type Json = Record<string, unknown>;

async function qlooGet(pathname: string, params: Record<string, string>): Promise<{ data: Json | null; source: DataSource }> {
  const qs = new URLSearchParams(params).toString();
  const cacheKey = `${pathname}?${qs}`;
  const fresh = await cacheGet<Json>(cacheKey, FRESH_MS);
  if (fresh) return { data: fresh.value, source: "cache" };

  if (qlooConfigured()) {
    const what = `${pathname} ${params.query ?? params["filter.tags"] ?? ""}`.slice(0, 80);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let waitMs = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      try {
        const res = await fetch(`${BASE}${pathname}?${qs}`, {
          headers: { "X-Api-Key": process.env.QLOO_API_KEY as string, accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get("retry-after"));
          if (ra > 0) waitMs = Math.min(3000, ra * 1000);
          throw new Error(`HTTP ${res.status}`);
        }
        if (!res.ok) {
          console.warn(`[qloo] ${what} -> HTTP ${res.status} (not retried)`);
          break;
        }
        const data = (await res.json()) as Json;
        await cacheSet(cacheKey, data);
        return { data, source: "live" };
      } catch (err) {
        console.warn(`[qloo] ${what} attempt ${attempt + 1}/${ATTEMPTS} failed: ${(err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message}`);
        if (attempt < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  const stale = await cacheGet<Json>(cacheKey, STALE_MS);
  if (stale) return { data: stale.value, source: "cache" };
  return { data: null, source: "fallback" };
}

// --- tag cleanup -----------------------------------------------------------
// Only taste-bearing tag families (genres, themes, cuisines, vibes); drop logistics like
// payments, parking, takeout, age ranges, nearby attractions.
const TASTE_TYPES = [
  "genre", "subgenre", "style", "theme", "archetype", "keyword", "cuisine", "culinary_style",
  "ambience", "decor", "setting", "interests", "category:place", "specialty_dish", "menu_highlight", "plot",
];
const NOISY_NAMES = new Set([
  "dining drinking", "restaurant", "place", "price level", "moderate", "dine in", "takeout", "delivery",
  "full bar", "drive thru", "reservations", "business", "destination", "point of interest", "establishment",
]);

interface RawTag { name?: string; type?: string; tag_id?: string; id?: string }

export function cleanTags(tags: unknown, limit = 20): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags as RawTag[]) {
    const name = t?.name?.trim();
    const type = t?.type || t?.tag_id || "";
    if (!name || /^\d+\s\d+$/.test(name) || NOISY_NAMES.has(name.toLowerCase())) continue;
    if (type && !TASTE_TYPES.some((n) => type.includes(n))) continue;
    if (!out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

const SEARCHABLE = new Set([
  "urn:entity:artist", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:book", "urn:entity:brand",
  "urn:entity:place", "urn:entity:podcast", "urn:entity:video_game", "urn:entity:destination", "urn:entity:person",
]);

interface RawEntity {
  name?: string;
  entity_id?: string;
  type?: string;
  types?: string[];
  tags?: unknown;
  popularity?: number;
  location?: { lat?: number; lon?: number };
  query?: { affinity?: number };
  properties?: {
    image?: { url?: string };
    short_description?: string;
    description?: string;
    address?: string;
    business_rating?: number;
    price_level?: number;
  };
}

export async function searchEntity(query: string, counter?: Counter, city?: string): Promise<{ entity: TasteEntity | null; source: DataSource }> {
  // Normalise: collapse whitespace, strip surrounding quotes/punctuation, lowercase for the cache key.
  const q = query.replace(/\s+/g, " ").replace(/^["'“”‘’.,;:!?\s]+|["'“”‘’.,;:!?\s]+$/g, "").trim().toLowerCase();
  if (!q) return { entity: null, source: "fallback" };
  const { data, source } = await qlooGet("/search", { query: q, take: "6" });
  const results = (data?.results as RawEntity[] | undefined) || null;
  if (!results) {
    if (counter) counter.fallback++;
    return { entity: fallbackSearch(q), source: "fallback" };
  }
  if (counter) counter[source]++;
  // Prefer a taste entity (artist, film, show, brand…) over a same-named venue somewhere in the world.
  const isTaste = (r: RawEntity) => (r.types || []).some((t) => SEARCHABLE.has(t) && t !== "urn:entity:place");
  let best = results.find(isTaste) || results.find((r) => (r.types || []).includes("urn:entity:place")) || results[0];
  if (!best?.entity_id) return { entity: null, source };
  // Food/place words ("ramen", "matcha") match random places worldwide; re-search inside the group's city.
  const isPlace = (best.types || []).includes("urn:entity:place");
  const cityKey = city?.trim().toLowerCase().split(/[ ,]/)[0];
  if (isPlace && cityKey && !(best.properties?.address || "").toLowerCase().includes(cityKey)) {
    const local = await qlooGet("/search", { query: `${q} ${city}`, types: "urn:entity:place", take: "5" });
    if (counter && local.data) counter[local.source]++;
    const locals = ((local.data?.results as RawEntity[] | undefined) || []).filter((r) => r.entity_id);
    const inCity = locals.find((r) => (r.properties?.address || "").toLowerCase().includes(cityKey)) || locals[0];
    if (inCity) best = inCity;
  }
  return {
    entity: {
      id: best.entity_id as string,
      name: best.name || q,
      type: (best.types || []).find((t) => SEARCHABLE.has(t)) || best.types?.[0] || "urn:entity",
      tags: cleanTags(best.tags, 12),
      image: best.properties?.image?.url,
      description: best.properties?.short_description,
    },
    source,
  };
}

export async function recommendPlaces(
  opts: { entityIds: string[]; city: string; category: CategoryKey; take?: number; tasteTags?: string[] },
  counter?: Counter,
): Promise<{ places: Place[]; source: DataSource }> {
  const real = opts.entityIds.filter((id) => !id.startsWith("sample:"));
  const params: Record<string, string> = {
    "filter.type": "urn:entity:place",
    "filter.location.query": opts.city,
    "filter.tags": CATEGORIES[opts.category].tags.join(","),
    take: String(opts.take ?? 20),
  };
  if (real.length) params["signal.interests.entities"] = real.join(",");
  const { data, source } = real.length ? await qlooGet("/v2/insights", params) : { data: null, source: "fallback" as DataSource };
  const ents = ((data?.results as Json | undefined)?.entities as RawEntity[] | undefined) || null;
  if (!ents || ents.length === 0) {
    if (counter) counter.fallback++;
    return { places: fallbackPlaces(opts.city, opts.category, opts.tasteTags || []), source: "fallback" };
  }
  if (counter) counter[source]++;
  return {
    places: ents
      .filter((e) => e.entity_id && e.name)
      .map((e) => ({
        id: e.entity_id as string,
        name: e.name as string,
        address: e.properties?.address,
        rating: e.properties?.business_rating ? Math.round(e.properties.business_rating * 10) / 10 : undefined,
        priceLevel: e.properties?.price_level,
        affinity: e.query?.affinity ?? 0,
        tags: cleanTags(e.tags, 14),
        image: e.properties?.image?.url,
        description: e.properties?.short_description || e.properties?.description,
        lat: e.location?.lat,
        lon: e.location?.lon,
      })),
    source,
  };
}


/**
 * Affinity of one person's taste profile for specific place IDs (Insights + filter.results.entities).
 * Used to compare places that fall outside someone's personal top list.
 */
export async function affinityFor(signalIds: string[], placeIds: string[], counter?: Counter): Promise<Map<string, number>> {
  const real = signalIds.filter((id) => !id.startsWith("sample:"));
  const ids = placeIds.filter((id) => !id.startsWith("sample:")).slice(0, 25);
  const out = new Map<string, number>();
  if (!real.length || !ids.length) return out;
  const { data, source } = await qlooGet("/v2/insights", {
    "filter.type": "urn:entity:place",
    "filter.results.entities": ids.join(","),
    "signal.interests.entities": real.join(","),
    take: String(ids.length),
  });
  if (counter) counter[data ? source : "fallback"]++;
  const ents = ((data?.results as Json | undefined)?.entities as RawEntity[] | undefined) || [];
  for (const e of ents) if (e.entity_id && typeof e.query?.affinity === "number") out.set(e.entity_id, e.query.affinity);
  return out;
}
