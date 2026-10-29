-- Ejecutar completo en Supabase > SQL Editor > New query
create extension if not exists pgcrypto;

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  ingredients text not null default '',
  category text not null check (category in ('Desayuno / Merienda','Almuerzo / Cena','Snacks / Postres')),
  for_milla boolean not null default false,
  photo_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  ingredients text not null default '',
  steps text not null default '',
  created_at timestamptz not null default now()
);

alter table public.meals enable row level security;
alter table public.recipes enable row level security;

drop policy if exists "own meals select" on public.meals;
drop policy if exists "own meals insert" on public.meals;
drop policy if exists "own meals update" on public.meals;
drop policy if exists "own meals delete" on public.meals;
create policy "own meals select" on public.meals for select to authenticated using (auth.uid() = user_id);
create policy "own meals insert" on public.meals for insert to authenticated with check (auth.uid() = user_id);
create policy "own meals update" on public.meals for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own meals delete" on public.meals for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "own recipes select" on public.recipes;
drop policy if exists "own recipes insert" on public.recipes;
drop policy if exists "own recipes update" on public.recipes;
drop policy if exists "own recipes delete" on public.recipes;
create policy "own recipes select" on public.recipes for select to authenticated using (auth.uid() = user_id);
create policy "own recipes insert" on public.recipes for insert to authenticated with check (auth.uid() = user_id);
create policy "own recipes update" on public.recipes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own recipes delete" on public.recipes for delete to authenticated using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-photos', 'meal-photos', false, 10485760, array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'])
on conflict (id) do update set public = false;

drop policy if exists "private meal photos select own folder" on storage.objects;
drop policy if exists "private meal photos insert own folder" on storage.objects;
drop policy if exists "private meal photos update own folder" on storage.objects;
drop policy if exists "private meal photos delete own folder" on storage.objects;
create policy "private meal photos select own folder" on storage.objects for select to authenticated using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "private meal photos insert own folder" on storage.objects for insert to authenticated with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "private meal photos update own folder" on storage.objects for update to authenticated using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "private meal photos delete own folder" on storage.objects for delete to authenticated using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = auth.uid()::text);
