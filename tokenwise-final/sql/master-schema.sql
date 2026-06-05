-- ============================================================
-- TokenWise — Master Database Schema
-- Run ALL of this in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- ── PART 1: Original schema-v2 indexes & RLS ─────────────────
create index if not exists compressions_user_created on public.compressions(user_id, created_at desc);
create index if not exists budget_alerts_user on public.budget_alerts(user_id);
create index if not exists team_members_user on public.team_members(user_id);
create index if not exists team_members_team on public.team_members(team_id);
create index if not exists profiles_email on public.profiles(email);
create index if not exists profiles_subscription on public.profiles(stripe_subscription_id) where stripe_subscription_id is not null;

create policy if not exists "Service can insert profiles" on public.profiles for insert with check (true);
create policy if not exists "Users can delete own sessions" on public.sessions for delete using (auth.uid() = user_id);
create policy if not exists "Users can delete own compressions" on public.compressions for delete using (auth.uid() = user_id);
create policy if not exists "Users can insert own alerts" on public.budget_alerts for insert with check (auth.uid() = user_id);

-- ── PART 2: Sessions table — new instrumentation columns ──────
alter table public.sessions add column if not exists prompt_length_before int;
alter table public.sessions add column if not exists prompt_length_after  int;
alter table public.sessions add column if not exists compression_ratio    float;
alter table public.sessions add column if not exists follow_up_count      int default 0;
alter table public.sessions add column if not exists session_completed    bool default false;
alter table public.sessions add column if not exists prompt_type          text;
alter table public.sessions add column if not exists prompt_hash          text;

-- ── PART 3: Profiles — training consent ──────────────────────
alter table public.profiles add column if not exists training_consent bool default false;
alter table public.profiles add column if not exists consent_date     timestamptz;
alter table public.profiles add column if not exists monthly_budget   numeric default 50;

-- ── PART 4: Teams — monthly_budget on members ────────────────
alter table public.team_members add column if not exists monthly_budget numeric default 50;

-- ── PART 5: Projects table ────────────────────────────────────
create table if not exists public.projects (
  id         uuid default gen_random_uuid() primary key,
  team_id    uuid references public.teams(id) on delete cascade,
  name       text not null,
  color      text default '#00a572',
  budget     numeric,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);
alter table public.projects enable row level security;
create policy if not exists "Team members can access projects"
  on public.projects for all
  using (
    exists (
      select 1 from public.team_members
      where team_id = projects.team_id and user_id = auth.uid()
    )
  );

-- ── PART 6: Prompt Library ────────────────────────────────────
create table if not exists public.prompt_library (
  id                 uuid default gen_random_uuid() primary key,
  user_id            uuid references auth.users(id) on delete cascade not null,
  created_at         timestamptz default now(),
  last_used_at       timestamptz default now(),
  original_text      text not null,
  compressed_text    text,
  prompt_hash        text not null,
  structure_hash     text,
  category           text default 'general',
  domain_tags        text[] default '{}',
  intent             text default 'unknown',
  use_count          int default 1,
  avg_follow_ups     float default 0,
  success_rate       float default 1.0,
  best_model         text,
  avg_tokens         int,
  avg_cost_usd       float,
  char_count         int,
  word_count         int,
  sentence_count     int,
  has_code_block     bool default false,
  has_bullet_list    bool default false,
  has_numbered_list  bool default false,
  question_count     int default 0,
  starts_with_verb   bool default false,
  has_examples       bool default false,
  has_constraints    bool default false,
  formality_score    float,
  title              text,
  is_pinned          bool default false,
  is_hidden          bool default false,
  user_notes         text,
  consented_training bool default false,
  unique(user_id, prompt_hash)
);

create table if not exists public.prompt_patterns (
  id           uuid default gen_random_uuid() primary key,
  user_id      uuid references auth.users(id) on delete cascade not null,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  pattern_name text not null,
  category     text not null,
  prompt_ids   uuid[] default '{}',
  count        int default 1,
  avg_tokens   int,
  avg_cost     float,
  best_model   text,
  sample_title text
);

create table if not exists public.prompt_uses (
  id              uuid default gen_random_uuid() primary key,
  prompt_id       uuid references public.prompt_library(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete cascade,
  used_at         timestamptz default now(),
  model_used      text,
  follow_up_count int default 0,
  completed       bool default true,
  tokens_used     int,
  cost_usd        float
);

create index if not exists pl_user_created  on public.prompt_library(user_id, created_at desc);
create index if not exists pl_user_hash     on public.prompt_library(user_id, prompt_hash);
create index if not exists pl_user_category on public.prompt_library(user_id, category);
create index if not exists pl_use_count     on public.prompt_library(user_id, use_count desc);
create index if not exists pu_prompt        on public.prompt_uses(prompt_id);
create index if not exists pu_user          on public.prompt_uses(user_id, used_at desc);

alter table public.prompt_library  enable row level security;
alter table public.prompt_patterns enable row level security;
alter table public.prompt_uses     enable row level security;

create policy if not exists "Users own their library"  on public.prompt_library  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy if not exists "Users own their patterns" on public.prompt_patterns for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy if not exists "Users own their uses"     on public.prompt_uses     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── PART 7: Context Portability ──────────────────────────────
create table if not exists public.context_sessions (
  id              uuid default gen_random_uuid() primary key,
  user_id         uuid references auth.users(id) on delete cascade not null,
  created_at      timestamptz default now(),
  site            text not null,
  model_used      text,
  context_summary text not null,
  topic_tags      text[] default '{}',
  token_count     int,
  summary_tokens  int,
  expires_at      timestamptz default (now() + interval '24 hours'),
  was_reused      bool default false,
  reused_on_site  text
);

create index if not exists cs_user_created  on public.context_sessions(user_id, created_at desc);
create index if not exists cs_user_expires  on public.context_sessions(user_id, expires_at);

alter table public.context_sessions enable row level security;
create policy if not exists "Users own their context"
  on public.context_sessions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Auto-delete expired context sessions (optional — run as cron or pg_cron)
-- delete from public.context_sessions where expires_at < now();

-- ── DONE ─────────────────────────────────────────────────────
-- After running: update Supabase Auth → URL Configuration:
--   Site URL: https://YOUR_DOMAIN.netlify.app
--   Redirect URLs: https://YOUR_DOMAIN.netlify.app/frontend/app.html
