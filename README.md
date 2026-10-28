# TasteHost 🍽️🎨🎶

**An AI agent that plans a group outing everyone will actually like.**

Each friend lists a few things they love (artists, films, shows, food, places). TasteHost's agent looks them up in
[Qloo's](https://qloo.com) cross-domain taste graph, finds where the group's tastes overlap, ranks real places in your
city against *each person's* taste profile, and builds a plan that's fair to everyone — with a reason per person for every stop.
Someone changes their mind? Hit **Re-plan** and see what stays and what changes.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com).

## Why it needs Qloo

A generic LLM plans "the famous landmark + the popular mall + a rooftop bar" for everyone. TasteHost shows that side by side:
the **Without Qloo** column is the same LLM with no taste data; the **With Qloo** column is grounded in Qloo Insights,
with a group-fit and fairness score per stop.

## How it works

```
Browser ──POST /api/plan──▶ Next.js route (server only, streams NDJSON events)
                              │
                              ├─ Agent loop (LLM tool-calling, or deterministic planner if no LLM key)
                              │    1. lookup_tastes      → Qloo /search          (favourites → entity IDs + taste tags)
                              │    2. find_shared_taste  → tag overlap across members
                              │    3. rank_places        → Qloo /v2/insights     (filter.type=urn:entity:place,
                              │                             filter.location.query=<city>, filter.tags=<category>,
                              │                             signal.interests.entities=<IDs>)
                              │                             1 group call + 1 call per member → per-person rank,
                              │                             groupScore = 0.4·avg + 0.4·min + 0.2·group rank, fairness = min/avg
                              │    4. finalize_plan      → picks + per-member reasons (validated against tool data)
                              └─ Generic baseline (same LLM, no tools) for the comparison panel
```

**Reliability for the demo:** every Qloo call goes through a private server-side cache (memory + temp-dir JSON, 24h fresh,
up to 30 days stale if Qloo is down), one retry on 429/5xx, a 9s timeout, and finally hand-written *sample* data so the
UI never dead-ends. The UI labels every step as `Qloo live`, `Qloo cache`, or `sample data`. The Qloo key never reaches
the browser. No Qloo response data is stored in this repo.

## Run locally

```bash
cp .env.example .env.local   # add QLOO_API_KEY (+ optional LLM key)
npm install
npm run dev                  # http://localhost:3000
```

## LLM providers

`src/lib/llm.ts` is provider-agnostic: OpenAI-compatible chat completions (OpenAI, Groq, xAI, Gemini, OpenRouter, or any
`LLM_BASE_URL`) and Anthropic Messages. Without a key the agent still runs the same Qloo tool sequence and writes
template explanations.

## Project structure

```
src/app/page.tsx              UI shell
src/components/Planner.tsx    group editor, live agent trace, plan cards, Qloo vs generic comparison, re-plan
src/app/api/plan/route.ts     streaming agent endpoint (validation + simple rate limit)
src/app/api/status/route.ts   which data source / LLM is active
src/lib/agent.ts              tool definitions + agent loop + deterministic fallback
src/lib/planner.ts            Qloo-backed tools, group-fair scoring, explanations
src/lib/qloo.ts               Qloo client (server-only), tag cleanup
src/lib/cache.ts              private server-side cache
src/lib/fallback.ts           hand-written sample data (used only when Qloo is unavailable)
src/lib/llm.ts                provider-agnostic LLM layer with tool calling
scripts/smoke.mjs             CLI smoke test: node scripts/smoke.mjs jakarta|bandung http://localhost:3000
```

## AI tools used

Built with AI coding assistants (Grok Bot / Claude). The runtime agent uses the configured LLM for tool calling.

## License

MIT © 2026 Riyan Aji Pangestu
