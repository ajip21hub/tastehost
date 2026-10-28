import { runAgent } from "@/lib/agent";
import { isCategory } from "@/lib/categories";
import type { AgentEvent, PlanRequest } from "@/lib/types";

export const maxDuration = 60;

const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 15;
}

const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");

function parse(body: unknown): PlanRequest | string {
  const b = (body || {}) as Record<string, unknown>;
  const city = str(b.city, 60);
  if (!city) return "city is required";
  const members = (Array.isArray(b.members) ? b.members : [])
    .slice(0, 6)
    .map((m: Record<string, unknown>) => ({
      name: str(m?.name, 40) || "Guest",
      loves: (Array.isArray(m?.loves) ? m.loves : []).map((l: unknown) => str(l, 80)).filter(Boolean).slice(0, 6),
    }))
    .filter((m) => m.loves.length);
  if (members.length < 1) return "add at least one member with something they love";
  const categories = (Array.isArray(b.categories) ? b.categories : []).filter(isCategory).slice(0, 4);
  return {
    city, members, categories,
    occasion: str(b.occasion, 60) || "Group outing",
    previousPickIds: (Array.isArray(b.previousPickIds) ? b.previousPickIds : []).map((x: unknown) => str(x, 80)).filter(Boolean).slice(0, 8),
    changeNote: str(b.changeNote, 200) || undefined,
  };
}

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return Response.json({ error: "Too many plans in a minute — try again shortly." }, { status: 429 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const req = parse(body);
  if (typeof req === "string") return Response.json({ error: req }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgent(req, emit);
      } catch (err) {
        emit({ type: "error", message: (err as Error).message || "planner failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
