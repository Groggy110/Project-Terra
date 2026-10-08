-- Terra — a children's home in Chengdu, China, with a website job sized for
-- one free afternoon. Fictional, like the world-wide sample.
-- Safe to re-run: it replaces only its own row (slug 'cn-chengdu-little-lamps-home').

begin;

delete from public.ministries where slug = 'cn-chengdu-little-lamps-home' and owner_id = (select id from auth.users where email = 'demo@example.org');

insert into public.ministries
  (owner_id, slug, name, city, country, lat, lon, region, focus, since, staff, languages, contact, blurb)
values
  ((select id from auth.users where email = 'demo@example.org'), 'cn-chengdu-little-lamps-home', 'Little Lamps Children''s Home', 'Chengdu', 'China', 30.6586, 104.0647, 'asia', array['children', 'education']::text[], 2008, 14, array['Mandarin', 'English']::text[], 'hello@little-lamps-chengdu.example.org', 'An orphanage in Chengdu, China since 2008: a family-style home for 32 children, with schooling support and foster families for those who can be placed.');

insert into public.needs
  (ministry_id, title, type, urgency, people, focus, remote, commitment, skills, tags, detail, posted, status)
select m.id, v.title, v.type, v.urgency, v.people, v.focus, v.remote, v.commitment, v.skills, v.tags, v.detail, v.posted::date, 'live'
from (values
  ('cn-chengdu-little-lamps-home', 'Website fix-up in one afternoon', 'expertise', 'urgent', 1, 'children', true, 'One afternoon · about 4 hrs', array['Web design', 'Squarespace or WordPress']::text[], array['web designer', 'web design', 'website', 'landing page', 'responsive design', 'design']::text[], 'Our orphanage''s one-page website in Chengdu breaks on a phone and the donate button goes nowhere. One afternoon from a web designer: tidy the layout, fix the button, and add a page about sponsoring a child. We have the words and photos ready.', '2026-10-06'),
  ('cn-chengdu-little-lamps-home', 'Child sponsors', 'funding', 'ongoing', 0, 'children', true, 'Monthly · ongoing', array['Monthly giving']::text[], array['sponsorship', 'giving', 'children']::text[], 'Monthly sponsors for the children at our home in Chengdu: food, school fees and a caregiver who stays. Each sponsor gets a letter and photos every term.', '2026-09-20')
) as v(slug, title, type, urgency, people, focus, remote, commitment, skills, tags, detail, posted)
join public.ministries m on m.slug = v.slug;

commit;
