// The page's Claude route. Authenticated with the user's Supabase JWT, metered per user per day.
// Body: { input: string | [{role, content}], tier?: "quick"|"default"|"complex", json?: boolean }
// Reply: { text, truncated, tier }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { callClaude, type Tier } from "../_shared/claude.ts";
import { admin } from "../_shared/db.ts";

const DAILY_CALLS = parseInt(Deno.env.get("AI_DAILY_CALLS") ?? "80", 10);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // who is asking
  const auth = req.headers.get("authorization") ?? "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user }, error: uerr } = await userClient.auth.getUser();
  if (uerr || !user) return json({ error: "sign in" }, 401);

  let body: { input?: unknown; tier?: Tier; json?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const input = body.input;
  const okInput = typeof input === "string" ? input.trim().length > 0 : Array.isArray(input) && input.length > 0 && input.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
  if (!okInput) return json({ error: "input must be a non-empty string or user/assistant turns" }, 400);
  const bytes = new TextEncoder().encode(typeof input === "string" ? input : JSON.stringify(input)).length;
  if (bytes > 262144) return json({ error: "prompt too large" }, 400);

  // budget
  const sb = admin();
  const day = new Date().toISOString().slice(0, 10);
  const { data: usage } = await sb.from("ai_usage").select("calls,in_tokens,out_tokens").eq("user_id", user.id).eq("day", day).maybeSingle();
  if ((usage?.calls ?? 0) >= DAILY_CALLS) return json({ error: "daily budget reached" }, 429);

  try {
    const r = await callClaude({ input: input as string, tier: body.tier, json: !!body.json });
    await sb.from("ai_usage").upsert({ user_id: user.id, day, calls: (usage?.calls ?? 0) + 1, in_tokens: (usage?.in_tokens ?? 0) + r.inTokens, out_tokens: (usage?.out_tokens ?? 0) + r.outTokens }, { onConflict: "user_id,day" });
    return json({ text: r.text, truncated: r.truncated, tier: body.tier ?? "default" });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 502);
  }
});
