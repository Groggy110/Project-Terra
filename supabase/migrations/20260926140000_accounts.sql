-- Linked accounts, the ministry dashboard, and richer profiles.

-- ------------------------------------------------------------ account links
--
-- A ministry leader can also serve personally, from a separate account. The
-- two are linked so either can switch to the other in one click. Rows are
-- written in both directions by the link-account function, which has proof
-- of both sign-ins; the browser can only read its own.
create table if not exists public.account_links (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  linked_id   uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, linked_id),
  check (user_id <> linked_id)
);

alter table public.account_links enable row level security;

drop policy if exists "see own links" on public.account_links;
create policy "see own links" on public.account_links
  for select using (auth.uid() = user_id);

drop policy if exists "remove own links" on public.account_links;
create policy "remove own links" on public.account_links
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------ needs: filled
--
-- A ministry can mark a need filled (and reopen it). What it must not be able
-- to do from the browser is move a need past moderation, which the update
-- policy alone allowed: status is checked here, not trusted.
alter table public.needs drop constraint if exists needs_status_check;
alter table public.needs add constraint needs_status_check
  check (status in ('live', 'pending_review', 'rejected', 'filled'));

create or replace function public.guard_need_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status
     and coalesce(auth.role(), '') in ('authenticated', 'anon')
     and not (
       (old.status = 'live' and new.status = 'filled') or
       (old.status = 'filled' and new.status = 'live')
     ) then
    raise exception 'status can only move between live and filled';
  end if;
  return new;
end $$;

drop trigger if exists needs_status_guard on public.needs;
create trigger needs_status_guard before update on public.needs
  for each row execute function public.guard_need_status();

-- ---------------------------------------------------------- richer profiles
alter table public.ministries add column if not exists website text;
alter table public.volunteer_profiles add column if not exists languages text[] not null default '{}';
alter table public.volunteer_profiles add column if not exists portfolio text;
