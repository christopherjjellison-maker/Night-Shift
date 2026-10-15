// Service-role access to the docs store, for the scheduler. Never ship this client to a browser.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
}

export type Doc = Record<string, unknown>;

export async function listDocs(sb: SupabaseClient, userId: string, collection: string): Promise<Doc[]> {
  const { data, error } = await sb.from("docs").select("doc_id,data").eq("user_id", userId).eq("collection", collection);
  if (error) throw error;
  return (data ?? []).map((r) => r.data as Doc);
}
export async function getDoc(sb: SupabaseClient, userId: string, collection: string, docId: string): Promise<Doc | null> {
  const { data, error } = await sb.from("docs").select("data").eq("user_id", userId).eq("collection", collection).eq("doc_id", docId).maybeSingle();
  if (error) throw error;
  return (data?.data as Doc) ?? null;
}
export async function setDoc(sb: SupabaseClient, userId: string, collection: string, docId: string, data: Doc) {
  const { error } = await sb.from("docs").upsert({ user_id: userId, collection, doc_id: docId, data }, { onConflict: "user_id,collection,doc_id" });
  if (error) throw error;
}

// local calendar day + hour for a user, from their IANA time zone
export function localNow(tz: string): { day: string; hour: number; iso: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10) % 24, iso: now.toISOString() };
}
export function shiftDay(day: string, n: number): string {
  const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
