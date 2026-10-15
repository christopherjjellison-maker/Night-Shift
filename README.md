# Night Shift

A home base for an ADHD brain. Night is a five-minute clock-out ritual. Day is one thing, one bar, capture. In between, the brain remembers and pushes back: a Morning Shift brief that quotes you, and one question at 10pm if you haven't checked in.

Installable on iPhone, Android, Mac and Windows from one URL (PWA). One codebase.

## How it's built

```
web/                     the app (static; deploy anywhere)
  index.html             the whole UI, ported from the Claude artifact prototype
  js/platform.js         shim: window.claude.use("db"|"sample"|"user"|"mcp") on top of Supabase + our Claude route
  js/auth.js             sign-in gate, 3-question onboarding, notification opt-in, account menu
  sw.js                  app-shell cache + push notifications
  manifest.webmanifest   install metadata + icons
  config.example.js      copy to config.js (Supabase URL, anon key, VAPID public key)
supabase/
  migrations/0001_init.sql   profiles, docs (the store), push_subscriptions, ai_usage, job_runs, RLS, realtime
  migrations/0002_cron.sql   hourly tick → scheduler function (fill in project ref + CRON_KEY first)
  functions/ai               the page's Claude route, metered per user per day
  functions/scheduler        per-user, per-time-zone dispatch of the brief and the nudge
  functions/_shared          claude.ts (API), db.ts (store helpers), jobs.ts (the brain), push.ts (web push)
```

The store is one generic table, `docs (user_id, collection, doc_id, data)`, which mirrors exactly how the prototype addressed data (`tasks/t1`, `brief/2026-10-15`, `meta/now`). That is why the UI ported without touching its logic. Row-level security means a user only ever sees their own rows; realtime streams their own changes to every device they are signed in on.

## Setup (about 30 minutes)

### 1. Supabase
1. Create a project at supabase.com. Note the project URL, anon key and service-role key (Settings → API).
2. SQL editor → run `supabase/migrations/0001_init.sql`.
3. Database → Extensions → enable `pg_cron` and `pg_net`.
4. Authentication → Providers: Email (magic link) is on by default. Add Google if you want the button to work (Client ID/secret from Google Cloud; add the Supabase callback URL there).
5. Authentication → URL configuration: set Site URL to where the web app will live, and add it to Redirect URLs.

### 2. Keys
- Anthropic API key: console.anthropic.com.
- VAPID keys for push: `npx web-push generate-vapid-keys` (prints a public and a private key).
- A CRON_KEY: any long random string (`openssl rand -hex 32`).

### 3. Edge functions
Install the Supabase CLI, then from the repo root:
```
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set ANTHROPIC_API_KEY=... CRON_KEY=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@yourdomain.com
supabase functions deploy ai
supabase functions deploy scheduler --no-verify-jwt
```
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions automatically.
Optional secrets: `AI_DAILY_CALLS` (default 80 per user per day), `CLAUDE_MODEL_QUICK`, `CLAUDE_MODEL_DEFAULT`, `CLAUDE_MODEL_COMPLEX` (confirm current model ids at docs.claude.com before launch).

### 4. Schedule the tick
Edit `supabase/migrations/0002_cron.sql`: put your project ref in the URL and your CRON_KEY in the header. Run it in the SQL editor. The scheduler runs at :07 every hour and fires each user's brief at their `brief_hour` and nudge at their `nudge_hour`, in their own time zone, once per local day.

Manual run for one user (handy while testing):
```
curl -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/scheduler?force=brief&user=USER-UUID" -H "x-cron-key: YOUR-CRON-KEY"
```

### 5. Web
```
cp web/config.example.js web/config.js   # fill in URL, anon key, VAPID public key
```
Deploy the `web/` folder to any static host. Vercel: import the repo, set Root Directory to `web`, framework "Other". Cloudflare Pages / Netlify: same idea. Local dev: `npx serve web` (push and the service worker need https or localhost).

### 6. Install it
Open the URL on your phone → Share → Add to Home Screen. It launches full-screen like a native app. On Mac, Chrome/Safari offer "Install" / "Add to Dock".

## Costs (ballpark)
Supabase free tier covers early users. Claude: sort/split/"from you" prompts run on the quick tier, the brief/nudge/mirror on the default tier; expect a few cents per active user per day. The `ai_usage` table shows exactly what each user spends.

## What's not in MVP
Google Calendar and starred-Gmail pulls (v1.1: needs Google OAuth with calendar/gmail scopes and a verification review), accountability rooms, Sunday mirror, open-thread memory, voice capture. The UI already hides the calendar/Gmail blocks when the connector layer is absent.

## Product notes
See `claude/night-shift-roadmap.md` in the Claude project for the product plan, the hook model and the three metrics that matter: shifts closed per week, Now slot picked by 10am, tasks older than 3 days.
