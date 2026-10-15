// Hourly tick. For every profile, works out their local hour and runs whichever job is due,
// at most once per local day (job_runs is the ledger). Protected by the x-cron-key header.
import { admin, localNow } from "../_shared/db.ts";
import { runBrief, runNudge, type Profile } from "../_shared/jobs.ts";

Deno.serve(async (req) => {
  const key = Deno.env.get("CRON_KEY");
  if (!key || req.headers.get("x-cron-key") !== key) return new Response("forbidden", { status: 403 });

  const sb = admin();
  const url = new URL(req.url);
  const force = url.searchParams.get("force");          // ?force=brief|nudge&user=<uuid> for manual runs
  const onlyUser = url.searchParams.get("user");

  let q = sb.from("profiles").select("*");
  if (onlyUser) q = q.eq("user_id", onlyUser);
  const { data: profiles, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const out: Record<string, unknown>[] = [];
  for (const p of (profiles ?? []) as Profile[]) {
    const { day, hour } = localNow(p.tz || "America/Los_Angeles");
    const due: string[] = [];
    if (force) due.push(force); else { if (hour === p.brief_hour) due.push("brief"); if (hour === p.nudge_hour) due.push("nudge"); }
    for (const job of due) {
      // claim the (user, job, day) slot first so two ticks never double-fire
      const { error: claimErr } = await sb.from("job_runs").insert({ user_id: p.user_id, job, local_day: day });
      if (claimErr) { if (!force) continue; }
      try {
        const note = job === "brief" ? await runBrief(sb, p, day) : await runNudge(sb, p, day);
        await sb.from("job_runs").update({ note: note ?? "skipped" }).eq("user_id", p.user_id).eq("job", job).eq("local_day", day);
        out.push({ user: p.user_id, job, day, note });
      } catch (e) {
        await sb.from("job_runs").update({ note: "error: " + String(e).slice(0, 200) }).eq("user_id", p.user_id).eq("job", job).eq("local_day", day);
        out.push({ user: p.user_id, job, day, error: String(e).slice(0, 200) });
      }
    }
  }
  return Response.json({ ran: out.length, out });
});
