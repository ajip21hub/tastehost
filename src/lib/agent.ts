import "server-only";
import { ALL_CATEGORIES, CATEGORIES, isCategory } from "./categories";
import { genericPlan } from "./fallback";
import { chat, llmConfig, llmLabel, reversedModels, type LlmConfig, type Msg, type ToolDef } from "./llm";
import { buildPlan, rankCategory, resolveMembers, sharedTaste } from "./planner";
import { newCounter, qlooConfigured } from "./qloo";
import { getCachedRun, planKey, putCachedRun } from "./planCache";
import type { AgentEvent, CategoryKey, PlanRequest, ResolvedMember, ScoredPlace } from "./types";

type Emit = (e: AgentEvent) => void;

const TOOLS: ToolDef[] = [
  {
    name: "lookup_tastes",
    description: "Resolve every group member's favourite things (artists, films, food, places, brands) into Qloo taste-graph entities. Call this first.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find_shared_taste",
    description: "Find taste tags that several members share, based on the resolved Qloo entities.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rank_places",
    description: "Ask Qloo for real places in the city for one category, ranked against EACH member's taste and the whole group's taste. Returns candidates with groupScore, fairness (min/avg member fit) and per-member fit.",
    parameters: {
      type: "object",
      properties: { category: { type: "string", enum: ALL_CATEGORIES } },
      required: ["category"],
      additionalProperties: false,
    },
  },
  {
    name: "finalize_plan",
    description: "Submit the final itinerary. Use only place_ids returned by rank_places. Give one pick per requested category, in a sensible order for the occasion.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        summary: { type: "string", description: "2 sentences, friendly, explains the group's shared taste." },
        picks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string", enum: ALL_CATEGORIES },
              place_id: { type: "string" },
              why: { type: "string", description: "One sentence: why this fits the whole group." },
              per_member: { type: "object", additionalProperties: { type: "string" }, description: "member name -> short reason grounded in rank_places data" },
            },
            required: ["category", "place_id", "why"],
          },
        },
      },
      required: ["title", "summary", "picks"],
    },
  },
];

function compactPlaces(list: ScoredPlace[]) {
  return list.slice(0, 6).map((p) => ({
    place_id: p.id, name: p.name, groupScore: p.groupScore, fairness: p.fairness, rating: p.rating, price_level: p.priceLevel,
    left_out: p.leftOut,
    tags: p.tags.slice(0, 6),
    member_fit: Object.fromEntries(Object.entries(p.memberFit).map(([n, f]) => [n, { score: f.score, reasons: f.reasons }])),
  }));
}

async function runAgentLive(req: PlanRequest, emit: Emit, onBusy?: () => Promise<boolean>) {
  const t0 = Date.now();
  const counter = newCounter();
  const cfg = llmConfig();
  const categories = (req.categories?.length ? req.categories : (["dining", "culture", "nightlife"] as CategoryKey[])).filter(isCategory);
  emit({ type: "status", qloo: qlooConfigured() ? "live Qloo API (cached)" : "sample data (no QLOO_API_KEY)", llm: llmLabel(cfg) });

  let stepId = 0;
  const state: { resolved: ResolvedMember[] | null; ranked: Partial<Record<CategoryKey, ScoredPlace[]>> } = { resolved: null, ranked: {} };

  const tools = {
    async lookup_tastes() {
      const s = Date.now();
      const { resolved, source } = await resolveMembers(req.members, counter, req.city);
      state.resolved = resolved;
      const missed = resolved.flatMap((m) => m.entities.filter((e) => e.type === "sample").map((e) => e.name));
      const detail =
        resolved.map((m) => `${m.name}: ${m.entities.map((e) => e.name).join(", ") || "—"}`).join(" · ") +
        (missed.length ? ` · Qloo lookup failed for: ${missed.join(", ")} (using sample tags)` : "");
      emit({ type: "step", id: ++stepId, tool: "lookup_tastes", label: "Looked up everyone's favourites in Qloo's taste graph", detail, source, ms: Date.now() - s });
      return resolved.map((m) => ({ member: m.name, entities: m.entities.map((e) => ({ name: e.name, type: e.type.replace("urn:entity:", ""), tags: e.tags.slice(0, 6) })), not_found: m.unresolved }));
    },
    async find_shared_taste() {
      if (!state.resolved) await tools.lookup_tastes();
      const shared = sharedTaste(state.resolved!);
      const top = shared.filter((x) => x.members.length > 1);
      emit({ type: "step", id: ++stepId, tool: "find_shared_taste", label: "Found where the group's tastes overlap", detail: (top.length ? top : shared).slice(0, 6).map((x) => `${x.tag} (${x.members.length})`).join(", ") || "little direct overlap — will optimise for fairness" });
      return shared;
    },
    async rank_places(args: { category?: unknown }) {
      const category = isCategory(args.category) ? args.category : categories[0];
      if (!state.resolved) await tools.lookup_tastes();
      const s = Date.now();
      const { places, source } = await rankCategory(state.resolved!, req.city, category, counter);
      state.ranked[category] = places;
      const top = places[0];
      emit({
        type: "step", id: ++stepId, tool: "rank_places",
        label: `${CATEGORIES[category].emoji} Ranked ${CATEGORIES[category].label.toLowerCase()} spots for each person`,
        detail: top ? `Top: ${top.name} — group fit ${Math.round(top.groupScore * 100)}%, fairness ${Math.round(top.fairness * 100)}%` : "no places found",
        source, ms: Date.now() - s,
      });
      return compactPlaces(places);
    },
  };

  // Generic (no-Qloo) baseline, for the side-by-side comparison.
  const genericPromise = (async () => {
    if (!cfg) return emit({ type: "generic", text: genericPlan(req.city).join("\n"), source: "static" });
    try {
      const r = await chat(reversedModels(cfg), [
        { role: "system", content: "You are a generic travel assistant with no access to taste data. Be brief." },
        { role: "user", content: `Plan a ${req.occasion} in ${req.city} for: ${req.members.map((m) => `${m.name} (likes ${m.loves.join(", ")})`).join("; ")}. Give 3-4 numbered stops, one short line each, plain text (no markdown), no intro.` },
      ], [], 1500, { sticky: false });
      const text = r.text.replace(/\*\*/g, "").trim();
      emit({ type: "generic", text: text || genericPlan(req.city).join("\n"), source: text ? "llm" : "static" });
    } catch {
      emit({ type: "generic", text: genericPlan(req.city).join("\n"), source: "static" });
    }
  })();

  let mode: "llm" | "deterministic" = "deterministic";
  let finalized = false;
  const llmStats = { turns: 0, model: undefined as string | undefined };
  let llmFailed = false;

  if (cfg) {
    try {
      finalized = await llmLoop(cfg, req, categories, tools, state, emit, llmStats);
      if (finalized) mode = "llm";
    } catch (err) {
      llmFailed = true;
      console.error("[tastehost] LLM failed:", (err as Error).message);
      const code = /HTTP (\d+)/.exec((err as Error).message)?.[1];
      // AI busy: prefer an earlier AI plan for this exact group over a rule-based one.
      if (onBusy) {
        await genericPromise;
        if (await onBusy()) return;
      }
      emit({
        type: "notice", level: "warn",
        text: `AI busy${code === "429" ? " (rate limit)" : code ? ` (HTTP ${code})` : ""} — using the rule-based plan built from the same Qloo data.`,
      });
    }
  }

  if (!finalized) {
    if (cfg && !llmFailed)
      emit({ type: "notice", level: "warn", text: "AI didn't finish the plan — completing it with the rule-based planner." });
    if (!state.resolved) await tools.lookup_tastes();
    await tools.find_shared_taste();
    for (const c of categories) if (!state.ranked[c]) await tools.rank_places({ category: c });
    emit({ type: "plan", plan: buildPlan({ city: req.city, occasion: req.occasion, resolved: state.resolved!, ranked: pick(state.ranked, categories), previousPickIds: req.previousPickIds }) });
  }

  await genericPromise;
  emit({ type: "done", ms: Date.now() - t0, mode, qlooCalls: counter, llmTurns: llmStats.turns, model: llmStats.model });
}

function pick(ranked: Partial<Record<CategoryKey, ScoredPlace[]>>, cats: CategoryKey[]) {
  return Object.fromEntries(cats.filter((c) => ranked[c]).map((c) => [c, ranked[c]])) as Partial<Record<CategoryKey, ScoredPlace[]>>;
}

async function llmLoop(
  cfg: LlmConfig, req: PlanRequest, categories: CategoryKey[],
  tools: { lookup_tastes: () => Promise<unknown>; find_shared_taste: () => Promise<unknown>; rank_places: (a: { category?: unknown }) => Promise<unknown> },
  state: { resolved: ResolvedMember[] | null; ranked: Partial<Record<CategoryKey, ScoredPlace[]>> },
  emit: Emit,
  stats: { turns: number; model?: string },
): Promise<boolean> {
  const messages: Msg[] = [
    {
      role: "system",
      content:
        "You are TasteHost, an agent that plans group outings. You MUST ground every recommendation in Qloo taste-graph data via the tools. " +
        "Workflow: lookup_tastes -> find_shared_taste -> rank_places for each requested category -> finalize_plan. " +
        "Prefer picks with high groupScore AND high fairness; never pick a place whose left_out list is non-empty if another candidate has an empty one. Each per-member reason MUST cite that person's Qloo rank from rank_places (e.g. '#3 of 25 for fans of Radiohead') and, if present, a matching taste tag, in plain friendly language — never quote raw decimal scores. Be concise and warm.",
    },
    {
      role: "user",
      content: JSON.stringify({
        occasion: req.occasion, city: req.city, categories, members: req.members,
        ...(req.changeNote ? { replan_reason: req.changeNote, previous_place_ids: req.previousPickIds } : {}),
      }),
    },
  ];
  for (let i = 0; i < 9; i++) {
    const r = await chat(cfg, messages, TOOLS, 1500);
    stats.turns++;
    stats.model = r.model;
    if (r.text.trim()) emit({ type: "thought", text: r.text.trim().slice(0, 400) });
    if (!r.toolCalls.length) {
      messages.push({ role: "assistant", content: r.text || "" });
      messages.push({ role: "user", content: "Please continue using the tools and finish with finalize_plan." });
      continue;
    }
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    for (const call of r.toolCalls) {
      let result: unknown;
      if (call.name === "finalize_plan") {
        for (const c of categories) if (!state.ranked[c]) await tools.rank_places({ category: c });
        const a = call.args as { title?: string; summary?: string; picks?: { category: string; place_id: string; why?: string; per_member?: Record<string, string> }[] };
        const chosen: Record<string, { placeId: string; why?: string; perMember?: Record<string, string> }> = {};
        for (const p of a.picks || []) if (isCategory(p.category)) chosen[p.category] = { placeId: p.place_id, why: p.why, perMember: p.per_member };
        emit({ type: "step", id: 999, tool: "finalize_plan", label: "Wrote the final plan with per-person reasons" });
        emit({
          type: "plan",
          plan: buildPlan({
            city: req.city, occasion: req.occasion, resolved: state.resolved || [], ranked: pick(state.ranked, categories),
            chosen, title: a.title, summary: a.summary, previousPickIds: req.previousPickIds,
          }),
        });
        return true;
      }
      try {
        if (call.name === "lookup_tastes") result = await tools.lookup_tastes();
        else if (call.name === "find_shared_taste") result = await tools.find_shared_taste();
        else if (call.name === "rank_places") result = await tools.rank_places(call.args);
        else result = { error: `unknown tool ${call.name}` };
      } catch (e) {
        result = { error: (e as Error).message };
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  return false;
}

/**
 * Entry point: serve a cached AI plan for an identical group instantly (unless re-planning or fresh=true),
 * otherwise run the agent live and cache the result when the AI loop completed it.
 */
export async function runAgent(req: PlanRequest, emit: Emit) {
  const t0 = Date.now();
  const key = planKey(req);
  const cacheable = !req.previousPickIds?.length && !req.changeNote;
  if (cacheable && !req.fresh) {
    const hit = await getCachedRun(key);
    if (hit) {
      for (const e of hit.events) {
        if (e.type === "done") {
          emit({ ...e, mode: "cached", cachedMode: "llm", cachedAt: hit.createdAt, ms: Date.now() - t0, qlooCalls: newCounter() });
        } else if (e.type === "step") {
          emit({ ...e, source: e.source ? "cache" : undefined, ms: 0 });
        } else if (e.type !== "thought" && e.type !== "notice") {
          emit(e);
        }
      }
      return;
    }
  }
  const recorded: AgentEvent[] = [];
  const onBusy = async () => {
    if (!cacheable) return false;
    const hit = await getCachedRun(key);
    if (!hit) return false;
    emit({ type: "notice", level: "warn", text: "AI busy — showing the cached AI plan for this exact group." });
    for (const e of hit.events) {
      if (e.type === "plan") emit(e);
      if (e.type === "done") emit({ ...e, mode: "cached", cachedMode: "llm", cachedAt: hit.createdAt, ms: Date.now() - t0, qlooCalls: newCounter() });
    }
    return true;
  };
  await runAgentLive(req, (e) => {
    recorded.push(e);
    emit(e);
  }, onBusy);
  const done = recorded.find((e) => e.type === "done");
  if (cacheable && done?.type === "done" && done.mode === "llm" && recorded.some((e) => e.type === "plan")) {
    await putCachedRun(key, { events: recorded, createdAt: Date.now() });
  }
}

/** Warm the plan cache for a request without streaming (used by /api/warm for the preset demo groups). */
export async function warmPlan(req: PlanRequest): Promise<"cached" | "warmed" | "rule-only"> {
  if (await getCachedRun(planKey(req))) return "cached";
  let mode: string | undefined;
  await runAgent(req, (e) => {
    if (e.type === "done") mode = e.mode;
  });
  return mode === "llm" ? "warmed" : "rule-only";
}
