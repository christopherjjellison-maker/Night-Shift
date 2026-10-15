// Web Push to every subscription a user has. Dead endpoints are pruned.
import webpush from "npm:web-push@3.6.7";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

let configured = false;
function setup() {
  if (configured) return;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY"), subject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@example.com";
  if (!pub || !priv) throw new Error("VAPID keys are not set");
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
}

export async function pushToUser(sb: SupabaseClient, userId: string, payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  setup();
  const { data } = await sb.from("push_subscriptions").select("id,endpoint,keys").eq("user_id", userId);
  let sent = 0;
  for (const s of data ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } }, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id);
    }
  }
  return sent;
}
