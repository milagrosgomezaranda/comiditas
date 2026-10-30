-- Migración aditiva v2. Ejecutar UNA sola vez después de revisar el estado actual.
-- No desactiva RLS, no elimina políticas y no recrea tablas.

alter table public.meals
  add column if not exists favorite boolean not null default false;

alter table public.recipes
  add column if not exists photo_path text,
  add column if not exists time_minutes integer,
  add column if not exists servings integer,
  add column if not exists category text,
  add column if not exists favorite boolean not null default false;

-- Restricciones defensivas, solo si todavía no existen.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'recipes_time_minutes_check') then
    alter table public.recipes add constraint recipes_time_minutes_check check (time_minutes is null or time_minutes between 0 and 1440);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recipes_servings_check') then
    alter table public.recipes add constraint recipes_servings_check check (servings is null or servings between 1 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recipes_category_check') then
    alter table public.recipes add constraint recipes_category_check check (
      category is null or category in ('Desayuno / Merienda','Almuerzo / Cena','Snacks / Postres')
    );
  end if;
end $$;

grant select, insert, update, delete on table public.meals, public.recipes to authenticated;
