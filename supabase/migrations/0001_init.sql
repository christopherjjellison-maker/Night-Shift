-- Night Shift: schema. One generic document table mirrors the artifact's collection/doc model
-- so the page logic ports unchanged; every row is owned by a user and locked down with RLS.

create extension if not exists pgcrypto;

-- who the brain is talking to
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  name        text,
  bluntness   text not null default 'frank',      -- frank | gentle
  chronotype  text not null default 'night',      -- night | early
  tz          text not null default 'America/Los_Angeles',
  brief_hour  int  not null default 8,            -- local hour the Morning Shift lands
  nudge_hour  int  not null default 22,           -- local hour the nudge fires
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- the store: collection/doc_id/data, exactly how the page addresses it
create table if not exists public.docs (
  user_id     uuid not null references auth.users(id) on delete cascade,
  collection  text not null,
  doc_id      text not null,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, collection, doc_id)
);
create index if not exists docs_user_collection on public.docs (user_id, collection);
create index if not exists docs_updated on public.docs (user_id, updated_at desc);

-- web push endpoints
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  keys        jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_user on public.push_subscriptions (user_id);

-- per-user daily Claude budget (written by the ai function with the service role)
create table if not exists public.ai_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  calls       int  not null default 0,
  in_tokens   int  not null default 0,
  out_tokens  int  not null default 0,
  primary key (user_id, day)
);

-- what the scheduler did, so it never double-fires and you can see it ran
create table if not exists public.job_runs (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  job         text not null,          -- brief | nudge
  local_day   date not null,
  ran_at      timestamptz not null default now(),
  note        text,
  unique (user_id, job, local_day)
);

-- updated_at upkeep
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs for each row execute function public.touch_updated_at();
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- a profile row the moment someone signs up
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- row-level security: you see your rows, nobody else's
alter table public.profiles enable row level security;
alter table public.docs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.ai_usage enable row level security;
alter table public.job_runs enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own push" on public.push_subscriptions;
create policy "own push" on public.push_subscriptions for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "read own usage" on public.ai_usage;
create policy "read own usage" on public.ai_usage for select to authenticated using (auth.uid() = user_id);

drop policy if exists "read own runs" on public.job_runs;
create policy "read own runs" on public.job_runs for select to authenticated using (auth.uid() = user_id);

-- realtime: the page subscribes to its own docs rows
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
alter table public.docs replica identity full;
