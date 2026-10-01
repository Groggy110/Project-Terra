-- Applications as an inbox: a ministry sees how many people have applied to
-- its needs since it last looked, and each application is "new" until opened.
--
-- Safe to re-run.

alter table public.interests add column if not exists seen_at timestamptz;

-- seen_at belongs to the ministry. A volunteer writing their own row cannot
-- set it, and an application they change is new again — the ministry has not
-- seen this version. (The ministry's own writes come through
-- mark_application_seen below, where auth.uid() is the ministry, not the
-- volunteer, so they pass through untouched.)
create or replace function public.guard_interest_seen() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and auth.uid() = new.user_id then
    if tg_op = 'INSERT' then
      new.seen_at := null;
    elsif new.why            is distinct from old.why
       or new.qualifications is distinct from old.qualifications
       or new.links          is distinct from old.links
       or new.files          is distinct from old.files then
      new.seen_at := null;
    else
      new.seen_at := old.seen_at;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists interests_seen_guard on public.interests;
create trigger interests_seen_guard before insert or update on public.interests
  for each row execute function public.guard_interest_seen();

-- How many applications to the caller's needs it has not opened yet.
create or replace function public.unseen_applications() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int
  from public.interests i
  join public.needs n on n.id = i.need_id
  join public.ministries m on m.id = n.ministry_id
  where m.owner_id = auth.uid()
    and i.seen_at is null
    and i.user_id <> auth.uid();
$$;

-- Marks one application opened, only if the need is the caller's.
create or replace function public.mark_application_seen(p_need uuid, p_user uuid) returns void
language sql security definer set search_path = '' as $$
  update public.interests i
  set seen_at = now()
  from public.needs n
  join public.ministries m on m.id = n.ministry_id
  where n.id = i.need_id
    and i.need_id = p_need
    and i.user_id = p_user
    and m.owner_id = auth.uid()
    and i.seen_at is null;
$$;

revoke execute on function public.unseen_applications() from public, anon;
revoke execute on function public.mark_application_seen(uuid, uuid) from public, anon;
grant execute on function public.unseen_applications() to authenticated;
grant execute on function public.mark_application_seen(uuid, uuid) to authenticated;
