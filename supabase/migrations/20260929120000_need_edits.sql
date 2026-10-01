-- Editing a need goes through moderation, like posting one.
--
-- The update policy lets a ministry update its own needs, which the
-- dashboard relies on to mark a need filled and reopen it. It also let the
-- browser rewrite a need's title and text directly — so a need could pass the
-- plausibility check and then be edited into something that never would have.
-- Edits now go through the moderate-need edge function (service role), which
-- checks the new text and writes it; from the browser, only the status may
-- change, and guard_need_status already limits that to live <-> filled.
--
-- Safe to re-run.

create or replace function public.guard_need_content() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') and (
       new.title      is distinct from old.title      or
       new.type       is distinct from old.type       or
       new.urgency    is distinct from old.urgency    or
       new.people     is distinct from old.people     or
       new.focus      is distinct from old.focus      or
       new.remote     is distinct from old.remote     or
       new.commitment is distinct from old.commitment or
       new.skills     is distinct from old.skills     or
       new.detail     is distinct from old.detail     or
       new.tags       is distinct from old.tags       or
       new.moderation is distinct from old.moderation or
       new.ministry_id is distinct from old.ministry_id
     ) then
    raise exception 'edit a need through the moderate-need function';
  end if;
  return new;
end $$;

drop trigger if exists needs_content_guard on public.needs;
create trigger needs_content_guard before update on public.needs
  for each row execute function public.guard_need_content();
