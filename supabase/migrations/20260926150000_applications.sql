-- Picking up a need is now a short application: why, what qualifies you, and
-- previous work as links or uploaded files.

-- ------------------------------------------------------ interests: answers
--
-- The answers live on the interest row itself. The "own interests" policy is
-- already `for all`, so the volunteer can write and rewrite them; the ministry
-- reads them only through the ministry-dashboard function.
alter table public.interests add column if not exists why text;
alter table public.interests add column if not exists qualifications text;
alter table public.interests add column if not exists links text[] not null default '{}';
-- [{ name, path, size, type }], path being the object in work-samples.
alter table public.interests add column if not exists files jsonb not null default '[]';

-- ------------------------------------------------------------ work samples
--
-- Private: nothing in it has a public URL. A volunteer writes and reads only
-- under a folder named for their own id; the ministry is handed short-lived
-- signed links by the dashboard function, which checks ownership of the need.
insert into storage.buckets (id, name, public, file_size_limit)
values ('work-samples', 'work-samples', false, 20971520)
on conflict (id) do nothing;

drop policy if exists "upload own work samples" on storage.objects;
create policy "upload own work samples" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'work-samples' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "read own work samples" on storage.objects;
create policy "read own work samples" on storage.objects
  for select to authenticated
  using (bucket_id = 'work-samples' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "delete own work samples" on storage.objects;
create policy "delete own work samples" on storage.objects
  for delete to authenticated
  using (bucket_id = 'work-samples' and (storage.foldername(name))[1] = auth.uid()::text);
