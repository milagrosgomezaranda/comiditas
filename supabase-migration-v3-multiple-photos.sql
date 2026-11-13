-- Comiditas v3: varias fotografías por comida. Migración ADITIVA e idempotente.
create table if not exists public.meal_photos (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  photo_path text not null,
  position integer not null default 0 check (position >= 0),
  is_cover boolean not null default false,
  crop_x numeric not null default 50 check (crop_x between 0 and 100),
  crop_y numeric not null default 50 check (crop_y between 0 and 100),
  created_at timestamptz not null default now(),
  unique(meal_id, photo_path)
);

create index if not exists meal_photos_meal_position_idx on public.meal_photos(meal_id, position);
alter table public.meal_photos enable row level security;

drop policy if exists "own meal photos select" on public.meal_photos;
drop policy if exists "own meal photos insert" on public.meal_photos;
drop policy if exists "own meal photos update" on public.meal_photos;
drop policy if exists "own meal photos delete" on public.meal_photos;
create policy "own meal photos select" on public.meal_photos for select to authenticated using (auth.uid() = user_id);
create policy "own meal photos insert" on public.meal_photos for insert to authenticated with check (auth.uid() = user_id);
create policy "own meal photos update" on public.meal_photos for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own meal photos delete" on public.meal_photos for delete to authenticated using (auth.uid() = user_id);
grant select, insert, update, delete on table public.meal_photos to authenticated;
