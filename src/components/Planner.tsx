"use client";

import { useMemo, useRef, useState } from "react";
import type { AgentEvent, CategoryKey, Member, Plan } from "@/lib/types";

const CATS: { key: CategoryKey; label: string; emoji: string }[] = [
  { key: "dining", label: "Dinner", emoji: "🍽️" },
  { key: "coffee", label: "Coffee & dessert", emoji: "☕" },
  { key: "culture", label: "Culture & activity", emoji: "🎨" },
  { key: "nightlife", label: "Music & nightlife", emoji: "🎶" },
];

const PRESETS: { label: string; city: string; occasion: string; members: Member[]; categories: CategoryKey[] }[] = [
  {
    label: "Friday night, Jakarta",
    city: "Jakarta",
    occasion: "Friday night out",
    categories: ["dining", "culture", "nightlife"],
    members: [
      { name: "Aji", loves: ["Radiohead", "Studio Ghibli", "ramen"] },
      { name: "Dina", loves: ["Taylor Swift", "Gilmore Girls", "matcha"] },
      { name: "Raka", loves: ["Hindia", "Interstellar", "sate padang"] },
    ],
  },
  {
    label: "Team offsite, Bandung",
    city: "Bandung",
    occasion: "Team offsite",
    categories: ["dining", "coffee", "culture"],
    members: [
      { name: "Sari", loves: ["Norah Jones", "Haruki Murakami"] },
      { name: "Budi", loves: ["Manchester United", "Fast & Furious"] },
      { name: "Lia", loves: ["BTS", "Crash Landing on You"] },
      { name: "Tom", loves: ["Anthony Bourdain", "The Bear"] },
    ],
  },
];

type Step = Extract<AgentEvent, { type: "step" }>;
type Done = Extract<AgentEvent, { type: "done" }>;

const sourceBadge: Record<string, string> = {
  live: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  cache: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  fallback: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
};

function price(n?: number) {
  return n ? "$".repeat(Math.min(4, n)) : null;
}

export default function Planner() {
  const [city, setCity] = useState(PRESETS[0].city);
  const [occasion, setOccasion] = useState(PRESETS[0].occasion);
  const [members, setMembers] = useState<Member[]>(PRESETS[0].members);
  const [categories, setCategories] = useState<CategoryKey[]>(PRESETS[0].categories);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [generic, setGeneric] = useState<{ text: string; source: string } | null>(null);
  const [status, setStatus] = useState<{ qloo: string; llm: string } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<string[]>([]);
  const lastPlan = useRef<Plan | null>(null);

  const canRun = useMemo(() => city.trim() && members.some((m) => m.loves.some((l) => l.trim())) && categories.length > 0, [city, members, categories]);

  function loadPreset(i: number) {
    const p = PRESETS[i];
    setCity(p.city); setOccasion(p.occasion); setMembers(p.members); setCategories(p.categories);
    setPlan(null); lastPlan.current = null; setSteps([]); setThoughts([]); setGeneric(null); setDone(null); setDirty([]);
  }

  function updateMember(i: number, patch: Partial<Member>) {
    setMembers((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    if (lastPlan.current) setDirty((d) => (d.includes(members[i].name) ? d : [...d, members[i].name]));
  }

  async function run(replan = false) {
    setRunning(true); setError(null); setSteps([]); setThoughts([]); setGeneric(null); setDone(null);
    if (!replan) { setPlan(null); lastPlan.current = null; }
    const prev = replan ? lastPlan.current : null;
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          city, occasion, categories,
          members: members.map((m) => ({ name: m.name, loves: m.loves.filter((l) => l.trim()) })),
          previousPickIds: prev?.picks.map((p) => p.place.id),
          changeNote: prev ? `${dirty.join(", ") || "Someone"} changed their preferences; keep good picks, swap what no longer fits.` : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as AgentEvent;
          if (ev.type === "status") setStatus({ qloo: ev.qloo, llm: ev.llm });
          else if (ev.type === "step") setSteps((s) => [...s, ev]);
          else if (ev.type === "thought") setThoughts((t) => [...t, ev.text]);
          else if (ev.type === "plan") { setPlan(ev.plan); lastPlan.current = ev.plan; }
          else if (ev.type === "generic") setGeneric({ text: ev.text, source: ev.source });
          else if (ev.type === "done") setDone(ev);
          else if (ev.type === "error") setError(ev.message);
        }
      }
      setDirty([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-amber-50">
            Taste<span className="text-amber-400">Host</span>
          </h1>
          <p className="mt-2 max-w-xl text-stone-300">
            An AI agent that plans a group outing everyone will actually like. Tell it what each friend loves — it
            uses <b className="text-amber-300">Qloo&apos;s taste graph</b> to find where your tastes overlap and picks the spots.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {PRESETS.map((p, i) => (
            <button key={p.label} onClick={() => loadPreset(i)} disabled={running}
              className="rounded-full border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-400 hover:text-amber-200">
              Demo: {p.label}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {/* ---------- left: the group ---------- */}
        <section className="h-fit rounded-2xl border border-stone-800 bg-stone-900/60 p-5">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-stone-400">City
              <input value={city} onChange={(e) => setCity(e.target.value)}
                className="mt-1 w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 outline-none focus:border-amber-400" />
            </label>
            <label className="text-xs text-stone-400">Occasion
              <input value={occasion} onChange={(e) => setOccasion(e.target.value)}
                className="mt-1 w-full rounded-lg border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100 outline-none focus:border-amber-400" />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {CATS.map((c) => {
              const on = categories.includes(c.key);
              return (
                <button key={c.key}
                  onClick={() => setCategories((cs) => (on ? cs.filter((x) => x !== c.key) : [...cs, c.key]))}
                  className={`rounded-full px-3 py-1 text-xs ring-1 ${on ? "bg-amber-400/15 text-amber-200 ring-amber-400/50" : "text-stone-400 ring-stone-700"}`}>
                  {c.emoji} {c.label}
                </button>
              );
            })}
          </div>

          <h2 className="mt-6 text-sm font-semibold text-stone-200">The group</h2>
          <div className="mt-2 space-y-3">
            {members.map((m, i) => (
              <div key={i} className={`rounded-xl border p-3 ${dirty.includes(m.name) ? "border-amber-400/60" : "border-stone-800"} bg-stone-950/60`}>
                <div className="flex items-center gap-2">
                  <input value={m.name} onChange={(e) => updateMember(i, { name: e.target.value })}
                    className="w-full bg-transparent text-sm font-medium text-amber-100 outline-none" />
                  <button onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))} disabled={members.length <= 1}
                    className="text-xs text-stone-500 hover:text-red-300" aria-label="Remove member">✕</button>
                </div>
                <input value={m.loves.join(", ")}
                  onChange={(e) => updateMember(i, { loves: e.target.value.split(",").map((s) => s.trimStart()) })}
                  placeholder="Loves: artists, films, food, places…"
                  className="mt-1 w-full rounded-md border border-stone-800 bg-stone-900 px-2 py-1.5 text-xs text-stone-200 outline-none focus:border-amber-400" />
              </div>
            ))}
          </div>
          {members.length < 6 && (
            <button onClick={() => setMembers((ms) => [...ms, { name: `Friend ${ms.length + 1}`, loves: [] }])}
              className="mt-3 text-xs text-amber-300 hover:text-amber-200">+ Add a friend</button>
          )}

          <div className="mt-6 flex gap-2">
            <button onClick={() => run(false)} disabled={!canRun || running}
              className="flex-1 rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 hover:bg-amber-300 disabled:opacity-50">
              {running ? "Planning…" : "Plan our outing"}
            </button>
            {plan && (
              <button onClick={() => run(true)} disabled={!canRun || running}
                title="Someone changed their mind? Re-plan and see what changes."
                className="rounded-xl border border-amber-400/60 px-4 py-3 text-sm text-amber-200 hover:bg-amber-400/10 disabled:opacity-50">
                Re-plan{dirty.length ? ` (${dirty.length})` : ""}
              </button>
            )}
          </div>
          {status && (
            <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
              Taste data: {status.qloo}<br />Agent brain: {status.llm}
            </p>
          )}
        </section>

        {/* ---------- right: agent + plan ---------- */}
        <section className="space-y-6">
          {error && <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">{error}</div>}

          {(steps.length > 0 || running) && (
            <div className="rounded-2xl border border-stone-800 bg-stone-900/60 p-5">
              <h2 className="text-sm font-semibold text-stone-200">Agent at work</h2>
              <ol className="mt-3 space-y-2">
                {steps.map((s, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="mt-0.5 font-mono text-xs text-stone-500">{String(i + 1).padStart(2, "0")}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-stone-200">
                        {s.label}
                        <code className="rounded bg-stone-800 px-1.5 text-[10px] text-stone-400">{s.tool}</code>
                        {s.source && <span className={`rounded px-1.5 text-[10px] ring-1 ${sourceBadge[s.source]}`}>{s.source === "fallback" ? "sample data" : `Qloo ${s.source}`}</span>}
                        {s.ms !== undefined && <span className="text-[10px] text-stone-500">{(s.ms / 1000).toFixed(1)}s</span>}
                      </div>
                      {s.detail && <p className="mt-0.5 truncate text-xs text-stone-400" title={s.detail}>{s.detail}</p>}
                    </div>
                  </li>
                ))}
                {running && <li className="animate-pulse text-xs text-amber-300">thinking…</li>}
              </ol>
              {thoughts.length > 0 && (
                <details className="mt-3 text-xs text-stone-400">
                  <summary className="cursor-pointer text-stone-500">Agent reasoning notes ({thoughts.length})</summary>
                  {thoughts.map((t, i) => <p key={i} className="mt-1 whitespace-pre-wrap">{t}</p>)}
                </details>
              )}
              {done && (
                <p className="mt-3 text-[11px] text-stone-500">
                  Done in {(done.ms / 1000).toFixed(1)}s · {done.mode === "llm" ? `LLM tool-calling loop (${done.llmTurns} turns${done.model ? `, ${done.model}` : ""})` : "deterministic planner"} · Qloo calls: {done.qlooCalls.live} live, {done.qlooCalls.cache} cached, {done.qlooCalls.fallback} sample
                </p>
              )}
            </div>
          )}

          {plan && (
            <div className="rounded-2xl border border-amber-400/30 bg-gradient-to-b from-amber-400/10 to-stone-900/60 p-5">
              <h2 className="text-2xl font-semibold text-amber-50">{plan.title}</h2>
              <p className="mt-1 text-sm text-stone-300">{plan.summary}</p>
              {plan.sharedTaste.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {plan.sharedTaste.slice(0, 8).map((t) => (
                    <span key={t.tag} title={t.members.join(", ")}
                      className="rounded-full bg-stone-800 px-2 py-0.5 text-[11px] text-stone-300">
                      {t.tag}{t.members.length > 1 ? ` ×${t.members.length}` : ""}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-5 space-y-4">
                {plan.picks.map((p, i) => {
                  const cat = CATS.find((c) => c.key === p.category)!;
                  return (
                    <article key={p.place.id} className="rounded-xl border border-stone-800 bg-stone-950/70 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-[11px] uppercase tracking-wider text-amber-300">Stop {i + 1} · {cat.emoji} {cat.label}</p>
                          <h3 className="text-lg font-semibold text-stone-100">{p.place.name}</h3>
                          <p className="text-xs text-stone-500">
                            {[p.place.address, p.place.rating ? `★ ${p.place.rating}` : null, price(p.place.priceLevel)].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {p.status && <span className={`rounded-full px-2 py-0.5 text-[10px] ${p.status === "new" ? "bg-fuchsia-500/20 text-fuchsia-200" : "bg-stone-800 text-stone-400"}`}>{p.status === "new" ? "new after re-plan" : "kept"}</span>}
                          <div className="text-right">
                            <div className="text-xl font-bold text-amber-300">{Math.round(p.place.groupScore * 100)}%</div>
                            <div className="text-[10px] text-stone-500">group fit · fairness {Math.round(p.place.fairness * 100)}%</div>
                          </div>
                        </div>
                      </div>
                      <p className="mt-2 text-sm text-stone-300">{p.why}</p>
                      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                        {Object.entries(p.perMember).map(([name, reason]) => {
                          const fit = p.place.memberFit[name]?.score ?? 0;
                          return (
                            <li key={name} className="rounded-lg bg-stone-900 p-2 text-xs">
                              <div className="flex items-center justify-between">
                                <span className="font-medium text-amber-100">{name}</span>
                                <span className="text-stone-500">{Math.round(fit * 100)}%</span>
                              </div>
                              <div className="mt-1 h-1 rounded bg-stone-800"><div className="h-1 rounded bg-amber-400" style={{ width: `${Math.round(fit * 100)}%` }} /></div>
                              <p className="mt-1 text-stone-400">{reason}</p>
                            </li>
                          );
                        })}
                      </ul>
                      {p.place.tags.length > 0 && <p className="mt-2 text-[11px] text-stone-500">{p.place.tags.slice(0, 6).join(" · ")}</p>}
                      {(plan.alternatives[p.category]?.length ?? 0) > 0 && (
                        <p className="mt-2 text-[11px] text-stone-500">Also good: {plan.alternatives[p.category]!.map((a) => a.name).join(", ")}</p>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {plan && generic && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-stone-800 bg-stone-900/40 p-5">
                <h3 className="text-sm font-semibold text-stone-400">Without Qloo: a generic planner</h3>
                <p className="mt-1 text-[11px] text-stone-500">{generic.source === "llm" ? "Same LLM, no taste data" : "Popularity-based tourist list"}</p>
                <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-stone-400">{generic.text}</pre>
              </div>
              <div className="rounded-2xl border border-amber-400/30 bg-stone-900/40 p-5">
                <h3 className="text-sm font-semibold text-amber-200">With Qloo: TasteHost</h3>
                <p className="mt-1 text-[11px] text-stone-500">Grounded in each person&apos;s taste profile</p>
                <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-stone-200">
                  {plan.picks.map((p) => <li key={p.place.id}>{p.place.name} <span className="text-stone-500">— strong fit for {Object.values(p.place.memberFit).filter((f) => f.score >= 0.7).length}/{Object.keys(p.place.memberFit).length} people</span></li>)}
                </ol>
              </div>
            </div>
          )}

          {!plan && !running && steps.length === 0 && (
            <div className="rounded-2xl border border-dashed border-stone-800 p-10 text-center text-sm text-stone-500">
              Add your friends and what they love, then hit <b className="text-stone-300">Plan our outing</b>.<br />
              Watch the agent query Qloo, find your shared taste, and build a plan that&apos;s fair to everyone.
            </div>
          )}
        </section>
      </div>

      <footer className="mt-10 text-center text-[11px] text-stone-600">
        Built for the Qloo Agentic Hackathon · Taste data by Qloo · MIT licensed
      </footer>
    </div>
  );
}
