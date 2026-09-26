-- First calls between a volunteer and a ministry.
--
-- Written only by the schedule-meeting function, which creates the Google
-- Calendar event (with its Meet link) and sends both sides the invitation.
-- Each side can read the calls they are part of; nobody writes from the
-- browser, for the same reason nobody inserts needs from it.
create table if not exists public.meetings (
  id            uuid primary key default gen_random_uuid(),
  need_id       uuid not null references public.needs(id) on delete cascade,
  ministry_id   uuid not null references public.ministries(id) on delete cascade,
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  starts_at     timestamptz not null,
  duration_min  int not null default 30 check (duration_min between 10 and 120),
  note          text,
  status        text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  meet_url      text,
  calendar_event_id text,
  created_at    timestamptz not null default now()
);

create index if not exists meetings_requester_idx on public.meetings (requester_id, starts_at);
create index if not exists meetings_ministry_idx on public.meetings (ministry_id, starts_at);

alter table public.meetings enable row level security;

drop policy if exists "see own meetings" on public.meetings;
create policy "see own meetings" on public.meetings
  for select using (
    auth.uid() = requester_id
    or exists (select 1 from public.ministries m where m.id = ministry_id and m.owner_id = auth.uid())
  );
