import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Two-layer private server-side cache for Qloo responses:
 *  1. in-memory Map (fast, per server instance)
 *  2. JSON files in a temp dir (survives dev restarts; /tmp on Vercel)
 * Qloo data is never written inside the repo (Qloo terms: no public storage).
 */
const mem = new Map<string, { at: number; value: unknown }>();
const DIR = process.env.QLOO_CACHE_DIR || path.join(os.tmpdir(), "tastehost-qloo-cache");
const MAX_MEM = 500;

function keyOf(raw: string) {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export async function cacheGet<T>(raw: string, maxAgeMs: number): Promise<{ value: T; age: number } | null> {
  const k = keyOf(raw);
  const now = Date.now();
  const hit = mem.get(k);
  if (hit && now - hit.at <= maxAgeMs) return { value: hit.value as T, age: now - hit.at };
  try {
    const txt = await fs.readFile(path.join(DIR, k + ".json"), "utf8");
    const parsed = JSON.parse(txt) as { at: number; value: T };
    if (now - parsed.at <= maxAgeMs) {
      mem.set(k, parsed);
      return { value: parsed.value, age: now - parsed.at };
    }
  } catch {
    /* miss */
  }
  return null;
}

export async function cacheSet(raw: string, value: unknown) {
  const k = keyOf(raw);
  const entry = { at: Date.now(), value };
  mem.set(k, entry);
  if (mem.size > MAX_MEM) {
    const first = mem.keys().next().value;
    if (first) mem.delete(first);
  }
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(path.join(DIR, k + ".json"), JSON.stringify(entry));
  } catch {
    /* read-only FS is fine; memory cache still works */
  }
}
