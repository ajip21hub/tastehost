import "server-only";

/**
 * Provider-agnostic LLM layer with tool calling.
 * - OpenAI-compatible chat/completions: openai, groq, xai, openrouter, gemini (OpenAI-compat endpoint), or any custom LLM_BASE_URL
 * - Anthropic Messages API
 * Configure with LLM_PROVIDER + LLM_API_KEY (+ optional LLM_MODEL, LLM_BASE_URL),
 * or just set one of the well-known vars (OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, XAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY).
 * LLM_MODEL may be a comma-separated list; later entries are fallbacks tried on 404/429/5xx/timeout.
 * No key => the agent runs in deterministic mode (same Qloo tools, template explanations).
 */

export type Provider = "openai" | "anthropic" | "groq" | "xai" | "gemini" | "openrouter" | "custom";

const PRESETS: Record<Exclude<Provider, "custom">, { env: string; baseUrl: string; model: string }> = {
  openai: { env: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  anthropic: { env: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5" },
  groq: { env: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  xai: { env: "XAI_API_KEY", baseUrl: "https://api.x.ai/v1", model: "grok-3-mini" },
  gemini: { env: "GEMINI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", // Verified 28 Oct 2026: tool calling works on these; 2.5 is closed to new keys, 3.7/3.8/flash-latest often 503.
    // Free tier is ~5 requests/min PER MODEL, so the fallback chain also spreads quota across models.
    model: "gemini-3.5-flash-lite,gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.6-flash" },
  openrouter: { env: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
};

export interface LlmConfig { provider: Provider; apiKey: string; model: string; fallbacks: string[]; baseUrl: string }

function withModels(provider: Provider, apiKey: string, baseUrl: string, modelSpec: string): LlmConfig {
  const models = modelSpec.split(",").map((m) => m.trim()).filter(Boolean);
  return { provider, apiKey, baseUrl, model: models[0], fallbacks: models.slice(1) };
}

export function llmConfig(): LlmConfig | null {
  const explicit = process.env.LLM_PROVIDER as Provider | undefined;
  if (explicit) {
    const preset = explicit !== "custom" ? PRESETS[explicit] : undefined;
    const apiKey = process.env.LLM_API_KEY || (preset ? process.env[preset.env] : undefined);
    const baseUrl = process.env.LLM_BASE_URL || preset?.baseUrl;
    const model = process.env.LLM_MODEL || preset?.model;
    if (apiKey && baseUrl && model) return withModels(explicit, apiKey, baseUrl, model);
    return null;
  }
  for (const [provider, p] of Object.entries(PRESETS) as [Exclude<Provider, "custom">, (typeof PRESETS)["openai"]][]) {
    const apiKey = process.env[p.env];
    if (apiKey) return withModels(provider, apiKey, process.env.LLM_BASE_URL || p.baseUrl, process.env.LLM_MODEL || p.model);
  }
  return null;
}

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown>; extra?: Record<string, unknown> }
export type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatResult { text: string; toolCalls: ToolCall[]; model?: string }

const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS || 20000);

function safeParse(s: unknown): Record<string, unknown> {
  if (s && typeof s === "object") return s as Record<string, unknown>;
  try { return JSON.parse(String(s || "{}")); } catch { return {}; }
}

async function openaiChat(cfg: LlmConfig, messages: Msg[], tools: ToolDef[], maxTokens: number): Promise<ChatResult> {
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    temperature: 0.4,
    messages: messages.map((m) => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      if (m.role === "assistant")
        return {
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) }, ...(c.extra || {}) })) }
            : {}),
        };
      return m;
    }),
    ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
  };
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`LLM ${cfg.provider} HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  return {
    text: msg.content || "",
    toolCalls: (msg.tool_calls || []).map((c: { id?: string; function: { name: string; arguments: string }; extra_content?: Record<string, unknown> }, i: number) => ({
      id: c.id || `call_${Date.now()}_${i}`, name: c.function.name, args: safeParse(c.function.arguments),
      // Gemini (OpenAI-compat) returns thought signatures here; they must be echoed back.
      ...(c.extra_content ? { extra: { extra_content: c.extra_content } } : {}),
    })),
  };
}

async function anthropicChat(cfg: LlmConfig, messages: Msg[], tools: ToolDef[], maxTokens: number): Promise<ChatResult> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  type Block = Record<string, unknown>;
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant") {
      const content: Block[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      m.toolCalls?.forEach((c) => content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args }));
      out.push({ role: "assistant", content });
    } else out.push({ role: "user", content: [{ type: "text", text: m.content }] });
  }
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: cfg.model, max_tokens: maxTokens, system, messages: out,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`LLM anthropic HTTP ${res.status}`);
  const data = await res.json();
  const blocks: Block[] = data?.content || [];
  return {
    text: blocks.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n"),
    toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), args: safeParse(b.input) })),
  };
}

/** Last model that answered, per provider — tried first next time (keeps a conversation on one model). */
const preferred = new Map<Provider, string>();

function retryable(err: unknown) {
  const e = err as Error;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  const code = Number(/HTTP (\d+)/.exec(e?.message || "")?.[1]);
  return code === 404 || code === 408 || code === 429 || code >= 500;
}

export async function chat(
  cfg: LlmConfig, messages: Msg[], tools: ToolDef[] = [], maxTokens = 1200, opts: { sticky?: boolean } = {},
): Promise<ChatResult> {
  const sticky = opts.sticky ?? true;
  const all = [cfg.model, ...cfg.fallbacks];
  const pref = sticky ? preferred.get(cfg.provider) : undefined;
  const order = pref && all.includes(pref) ? [pref, ...all.filter((m) => m !== pref)] : all;
  let lastErr: unknown;
  for (const model of order) {
    const c = { ...cfg, model };
    try {
      const r = cfg.provider === "anthropic" ? await anthropicChat(c, messages, tools, maxTokens) : await openaiChat(c, messages, tools, maxTokens);
      if (sticky) preferred.set(cfg.provider, model);
      return { ...r, model };
    } catch (err) {
      lastErr = err;
      console.warn(`[tastehost] LLM model ${model} failed: ${(err as Error).message.slice(0, 120)}`);
      if (!retryable(err)) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("LLM failed");
}

export function llmLabel(cfg: LlmConfig | null) {
  if (!cfg) return "deterministic (no LLM key)";
  const active = preferred.get(cfg.provider) || cfg.model;
  return `${cfg.provider} · ${active}${cfg.fallbacks.length ? ` (+${cfg.fallbacks.length} fallback${cfg.fallbacks.length > 1 ? "s" : ""})` : ""}`;
}

/** Same config but starting from the last fallback model — used for side calls so they don't eat the main model's quota. */
export function reversedModels(cfg: LlmConfig): LlmConfig {
  const all = [cfg.model, ...cfg.fallbacks].reverse();
  return { ...cfg, model: all[0], fallbacks: all.slice(1) };
}
