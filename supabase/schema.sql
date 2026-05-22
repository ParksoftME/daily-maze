-- Daily Maze2 — Supabase schema
-- Supabase Dashboard → SQL Editor에서 실행하세요.
-- Google OAuth: Authentication → Providers → Google 활성화
-- Redirect URL: daily-maze2://auth/callback (및 Expo 개발용 exp://...)

-- ── profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text,
  short_id text not null unique,
  avatar_url text,
  created_at timestamptz not null default now(),
  constraint profiles_short_id_len check (char_length(short_id) = 6)
);

-- ── daily_results ───────────────────────────────────────────────────────────
create table if not exists public.daily_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  diff text not null check (diff in ('easy', 'normal', 'hard')),
  slot int not null check (slot >= 0 and slot <= 2),
  date date not null,
  clear_time int not null check (clear_time >= 0),
  trail_data jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, diff, slot, date)
);

create index if not exists daily_results_user_date_idx
  on public.daily_results (user_id, date desc);

-- ── streaks ─────────────────────────────────────────────────────────────────
create table if not exists public.streaks (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  current_streak int not null default 0 check (current_streak >= 0),
  last_clear_date date
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.daily_results enable row level security;
alter table public.streaks enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

create policy "daily_results_select_own"
  on public.daily_results for select
  using (auth.uid() = user_id);

create policy "daily_results_insert_own"
  on public.daily_results for insert
  with check (auth.uid() = user_id);

create policy "daily_results_update_own"
  on public.daily_results for update
  using (auth.uid() = user_id);

create policy "streaks_select_own"
  on public.streaks for select
  using (auth.uid() = user_id);

create policy "streaks_upsert_own"
  on public.streaks for insert
  with check (auth.uid() = user_id);

create policy "streaks_update_own"
  on public.streaks for update
  using (auth.uid() = user_id);

-- 신규 가입 시 profiles 행 자동 생성 (short_id는 앱에서 설정·갱신 가능)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_short text;
  tries int := 0;
begin
  loop
    tries := tries + 1;
    new_short := upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 6));
    begin
      insert into public.profiles (id, short_id)
      values (new.id, new_short);
      exit;
    exception when unique_violation then
      if tries > 20 then raise; end if;
    end;
  end loop;
  insert into public.streaks (user_id, current_streak, last_clear_date)
  values (new.id, 0, null)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
