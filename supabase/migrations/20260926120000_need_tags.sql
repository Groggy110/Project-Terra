-- AI skill tags on needs, for search.
--
-- Written by the moderate-need function when a need is posted (and backfilled
-- once by tag-needs). Ordered from most specific to broadest — "logo design",
-- "brand identity", "graphic design", "design" — so search can rank an exact
-- specialism above the family it belongs to. Public like the rest of the row.
alter table public.needs
  add column if not exists tags text[] not null default '{}';

create index if not exists needs_tags_idx on public.needs using gin (tags);
