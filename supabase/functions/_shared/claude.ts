// Claude Messages API on our own key. Tiers map to models via env so retirements are a config change.
// Confirm current model ids at https://docs.claude.com before launch.
const API = "https://api.anthropic.com/v1/messages";

export type Tier = "quick" | "default" | "complex";
const MODELS: Record<Tier, string> = {
  quick: Deno.env.get("CLAUDE_MODEL_QUICK") ?? "claude-haiku-5-5",
  default: Deno.env.get("CLAUDE_MODEL_DEFAULT") ?? "claude-sonnet-5-5",
  complex: Deno.env.get("CLAUDE_MODEL_COMPLEX") ?? "claude-opus-5-5",
};

export type Msg = { role: "user" | "assistant"; content: string };

export interface ClaudeResult { text: string; truncated: boolean; model: string; inTokens: number; outTokens: number; }

export async function callClaude(opts: { input: string | Msg[]; tier?: Tier; json?: boolean; system?: string; maxTokens?: number }): Promise<ClaudeResult> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const tier: Tier = opts.tier && MODELS[opts.tier] ? opts.tier : "default";
  const messages: Msg[] = typeof opts.input === "string" ? [{ role: "user", content: opts.input }] : opts.input;
  let system = opts.system ?? "You are the brain inside Night Shift, a home base app for people with ADHD. Be frank, warm, casual and specific. Quote the person's own words where it lands. No platitudes, no bullet lists unless asked.";
  if (opts.json) system += " Reply with only the JSON value requested, no prose, no code fence.";
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODELS[tier], max_tokens: opts.maxTokens ?? (opts.json ? 1024 : 1500), system, messages }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`claude ${res.status}: ${t.slice(0, 300)}`); }
  const j = await res.json();
  const text = (j.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n").trim();
  return { text, truncated: j.stop_reason === "max_tokens", model: j.model, inTokens: j.usage?.input_tokens ?? 0, outTokens: j.usage?.output_tokens ?? 0 };
}

export function parseJsonTolerant(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) { try { return JSON.parse(fence[1]); } catch { /* fallthrough */ } }
  const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch { /* fallthrough */ } }
  throw new Error("no JSON in reply");
}
