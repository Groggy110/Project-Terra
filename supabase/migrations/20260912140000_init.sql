-- Terra — schema, row-level security and triggers.
--
-- Run this whole file once in the Supabase SQL Editor (Dashboard → SQL Editor →
-- New query → paste → Run). It is safe to re-run: every object is created with
-- "if not exists" or dropped first.
--
-- The security model in one paragraph: the browser talks to Postgres directly
-- with the anon key, so *row-level security is the only thing protecting this
-- data* — there is no server in between to check permissions. Every table below
-- therefore has RLS enabled and an explicit policy per operation. A table with
-- RLS on and no policy for an operation denies that operation to everyone,
-- which is the failure mode we want: forgetting a policy locks data down rather
-- than exposing it.

-- ---------------------------------------------------------------- profiles

-- One row per signed-up user, created automatically by the trigger at the
-- bottom. Kept separate from auth.users because that table belongs to Supabase
-- and should not carry application columns.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        text not null default 'volunteer' check (role in ('volunteer', 'ministry')),
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "own profile readable" on public.profiles;
create policy "own profile readable" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "own profile writable" on public.profiles;
create policy "own profile writable" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- -------------------------------------------------------------- ministries

create table if not exists public.ministries (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  slug        text unique not null,
  name        text not null,
  city        text not null,
  country     text not null,
  -- The globe places a pin from these two and nothing else, so they are not
  -- optional: a ministry without coordinates cannot be drawn.
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  region      text,
  focus       text[] not null default '{}',
  since       integer,
  staff       integer,
  languages   text[] not null default '{}',
  contact     text,
  blurb       text,
  created_at  timestamptz not null default now()
);

create index if not exists ministries_owner_idx on public.ministries (owner_id);

alter table public.ministries enable row level security;

-- Public: the globe has to render for signed-out visitors.
drop policy if exists "ministries are public" on public.ministries;
create policy "ministries are public" on public.ministries
  for select using (true);

drop policy if exists "own ministry insertable" on public.ministries;
create policy "own ministry insertable" on public.ministries
  for insert with check (auth.uid() = owner_id);

drop policy if exists "own ministry updatable" on public.ministries;
create policy "own ministry updatable" on public.ministries
  for update using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "own ministry deletable" on public.ministries;
create policy "own ministry deletable" on public.ministries
  for delete using (auth.uid() = owner_id);

-- ------------------------------------------------------------------- needs

create table if not exists public.needs (
  id           uuid primary key default gen_random_uuid(),
  ministry_id  uuid not null references public.ministries(id) on delete cascade,
  title        text not null,
  type         text not null check (type in ('volunteers', 'expertise', 'supplies', 'funding', 'partners')),
  urgency      text not null check (urgency in ('urgent', 'soon', 'ongoing')),
  -- 0 for needs that want goods, money or an organisation rather than a person,
  -- which is why the network total counts people and not needs.
  people       integer not null default 0 check (people >= 0),
  focus        text,
  remote       boolean not null default false,
  commitment   text,
  skills       text[] not null default '{}',
  detail       text,
  -- Set by the moderate-need edge function, never by the browser. Defaults to
  -- pending_review so that anything which somehow reaches this table without
  -- passing moderation is invisible rather than live.
  status       text not null default 'pending_review' check (status in ('live', 'pending_review', 'rejected')),
  moderation   jsonb,
  posted       date not null default current_date,
  created_at   timestamptz not null default now()
);

create index if not exists needs_ministry_idx on public.needs (ministry_id);
create index if not exists needs_status_idx on public.needs (status);

alter table public.needs enable row level security;

-- Everyone sees live needs. Nobody sees anything under review except the
-- ministry that wrote it.
drop policy if exists "live needs are public" on public.needs;
create policy "live needs are public" on public.needs
  for select using (status = 'live');

drop policy if exists "own needs visible in any status" on public.needs;
create policy "own needs visible in any status" on public.needs
  for select using (
    exists (
      select 1 from public.ministries m
      where m.id = needs.ministry_id and m.owner_id = auth.uid()
    )
  );

-- Deliberately NO insert policy.
--
-- Inserting is the one operation the browser must not be able to do directly,
-- because that is exactly how you would skip the plausibility check. The
-- moderate-need edge function holds the service-role key, which bypasses RLS,
-- and is therefore the only writer. A missing policy denies the operation, so
-- this comment is the entire enforcement mechanism — do not "fix" it by adding
-- one.

drop policy if exists "own needs updatable" on public.needs;
create policy "own needs updatable" on public.needs
  for update using (
    exists (
      select 1 from public.ministries m
      where m.id = needs.ministry_id and m.owner_id = auth.uid()
    )
  );

drop policy if exists "own needs deletable" on public.needs;
create policy "own needs deletable" on public.needs
  for delete using (
    exists (
      select 1 from public.ministries m
      where m.id = needs.ministry_id and m.owner_id = auth.uid()
    )
  );

-- ------------------------------------------------------ volunteer profiles

-- The five-question questionnaire. One row per user, written only by that user,
-- and the sole input the recommender gets about a person.
create table if not exists public.volunteer_profiles (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  skills       text[] not null default '{}',
  serve_mode   text[] not null default '{}',
  availability text,
  experience   text,
  causes       text[] not null default '{}',
  updated_at   timestamptz not null default now()
);

alter table public.volunteer_profiles enable row level security;

drop policy if exists "own volunteer profile" on public.volunteer_profiles;
create policy "own volunteer profile" on public.volunteer_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --------------------------------------------------------------- interests

create table if not exists public.interests (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  need_id    uuid not null references public.needs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, need_id)
);

create index if not exists interests_need_idx on public.interests (need_id);

alter table public.interests enable row level security;

drop policy if exists "own interests" on public.interests;
create policy "own interests" on public.interests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------- triggers

-- A profile row for every new signup. security definer because the trigger runs
-- as the inserting role, which has no rights on public.profiles; the empty
-- search_path is the standard hardening so the function cannot be hijacked by a
-- shadowing schema.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    coalesce(new.raw_user_meta_data ->> 'role', 'volunteer')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
