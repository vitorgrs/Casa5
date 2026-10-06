-- Calendário de lavanderia, rodízio dos moradores e lavagens coletivas.
-- Rode depois da 020_anonymous_complaints.sql.

create table if not exists public.laundry_rotation_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  anchor_date date not null,
  anchor_member_id uuid not null,
  gap_days integer not null default 2 check (gap_days between 0 and 30),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (household_id, anchor_member_id)
    references public.household_members(household_id, id) on delete cascade
);

create table if not exists public.laundry_rotation_members (
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  rotation_order integer not null check (rotation_order > 0),
  created_at timestamptz not null default now(),
  primary key (household_id, member_id),
  unique (household_id, rotation_order),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

create table if not exists public.laundry_rotation_overrides (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  wash_date date not null,
  member_id uuid not null,
  resets_rotation boolean not null default false,
  note text check (note is null or char_length(note) <= 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (household_id, wash_date),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

create table if not exists public.laundry_collective_washes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  wash_date date not null,
  item_type text not null check (item_type in (
    'floor_cloths',
    'shoes',
    'dish_hand_cloths',
    'towels',
    'bedding',
    'other'
  )),
  custom_label text check (
    custom_label is null or char_length(trim(custom_label)) between 2 and 100
  ),
  note text check (note is null or char_length(note) <= 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint laundry_collective_custom_label_check check (
    item_type <> 'other' or custom_label is not null
  )
);

create index if not exists laundry_collective_washes_period_idx
  on public.laundry_collective_washes(household_id, wash_date);
create index if not exists laundry_rotation_overrides_period_idx
  on public.laundry_rotation_overrides(household_id, wash_date);

alter table public.laundry_rotation_settings enable row level security;
alter table public.laundry_rotation_members enable row level security;
alter table public.laundry_rotation_overrides enable row level security;
alter table public.laundry_collective_washes enable row level security;

create policy laundry_rotation_settings_read on public.laundry_rotation_settings
for select to authenticated
using (household_id = public.current_household_id());
create policy laundry_rotation_settings_admin_all on public.laundry_rotation_settings
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

create policy laundry_rotation_members_read on public.laundry_rotation_members
for select to authenticated
using (household_id = public.current_household_id());
create policy laundry_rotation_members_admin_all on public.laundry_rotation_members
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

create policy laundry_rotation_overrides_read on public.laundry_rotation_overrides
for select to authenticated
using (household_id = public.current_household_id());
create policy laundry_rotation_overrides_admin_all on public.laundry_rotation_overrides
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

create policy laundry_collective_washes_read on public.laundry_collective_washes
for select to authenticated
using (household_id = public.current_household_id());
create policy laundry_collective_washes_admin_all on public.laundry_collective_washes
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

-- A ordem inicial solicitada é Vitor, Patrick, Belo, William e Sávio.
insert into public.laundry_rotation_members (household_id, member_id, rotation_order)
select seed.household_id, seed.member_id, seed.rotation_order
from (values
  ('11111111-1111-1111-1111-111111111111'::uuid, '11111111-1111-1111-1111-111111111101'::uuid, 1),
  ('11111111-1111-1111-1111-111111111111'::uuid, '11111111-1111-1111-1111-111111111104'::uuid, 2),
  ('11111111-1111-1111-1111-111111111111'::uuid, '11111111-1111-1111-1111-111111111102'::uuid, 3),
  ('11111111-1111-1111-1111-111111111111'::uuid, '11111111-1111-1111-1111-111111111105'::uuid, 4),
  ('11111111-1111-1111-1111-111111111111'::uuid, '11111111-1111-1111-1111-111111111103'::uuid, 5)
) as seed(household_id, member_id, rotation_order)
where exists (
  select 1 from public.household_members member
  where member.household_id = seed.household_id and member.id = seed.member_id
)
on conflict (household_id, member_id) do nothing;

-- Sávio em 08/10 é a âncora da sequência futura. A lavagem já realizada por
-- Belo em 05/10 fica como registro histórico, sem alterar o rodízio seguinte.
insert into public.laundry_rotation_settings (
  household_id,
  anchor_date,
  anchor_member_id,
  gap_days
)
select
  '11111111-1111-1111-1111-111111111111'::uuid,
  '2026-10-08'::date,
  '11111111-1111-1111-1111-111111111103'::uuid,
  2
where exists (
  select 1 from public.household_members
  where household_id = '11111111-1111-1111-1111-111111111111'::uuid
    and id = '11111111-1111-1111-1111-111111111103'::uuid
)
on conflict (household_id) do nothing;

insert into public.laundry_rotation_overrides (
  household_id,
  wash_date,
  member_id,
  resets_rotation,
  note
)
select
  '11111111-1111-1111-1111-111111111111'::uuid,
  '2026-10-05'::date,
  '11111111-1111-1111-1111-111111111102'::uuid,
  false,
  'Lavagem de Belo já realizada antes do início da nova sequência.'
where exists (
  select 1 from public.household_members
  where household_id = '11111111-1111-1111-1111-111111111111'::uuid
    and id = '11111111-1111-1111-1111-111111111102'::uuid
)
on conflict (household_id, wash_date) do nothing;

create or replace function public.set_laundry_rotation(
  rotation_anchor_date date,
  rotation_anchor_member_id uuid,
  rotation_gap_days integer,
  ordered_member_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  active_count integer;
  provided_count integer;
  distinct_count integer;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode configurar a lavanderia.';
  end if;
  if rotation_anchor_date is null then
    raise exception 'Informe a data de referência da escala.';
  end if;
  if rotation_gap_days is null or rotation_gap_days < 0 or rotation_gap_days > 30 then
    raise exception 'O intervalo deve estar entre 0 e 30 dias.';
  end if;

  select count(*)::integer into active_count
  from public.household_members
  where household_id = acting_profile.household_id and active = true;

  select count(*)::integer, count(distinct value)::integer
    into provided_count, distinct_count
  from unnest(ordered_member_ids) as provided(value);

  if provided_count = 0 or provided_count <> active_count or distinct_count <> provided_count then
    raise exception 'A ordem deve conter todos os moradores ativos uma única vez.';
  end if;
  if not (rotation_anchor_member_id = any(ordered_member_ids)) then
    raise exception 'O morador da data de referência precisa estar na escala.';
  end if;
  if exists (
    select 1
    from unnest(ordered_member_ids) as provided(value)
    where not exists (
      select 1 from public.household_members member
      where member.id = provided.value
        and member.household_id = acting_profile.household_id
        and member.active = true
    )
  ) then
    raise exception 'A ordem contém um morador inválido ou inativo.';
  end if;

  insert into public.laundry_rotation_settings (
    household_id,
    anchor_date,
    anchor_member_id,
    gap_days,
    updated_by,
    updated_at
  ) values (
    acting_profile.household_id,
    rotation_anchor_date,
    rotation_anchor_member_id,
    rotation_gap_days,
    acting_profile.id,
    now()
  )
  on conflict (household_id) do update
  set anchor_date = excluded.anchor_date,
      anchor_member_id = excluded.anchor_member_id,
      gap_days = excluded.gap_days,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  delete from public.laundry_rotation_members
  where household_id = acting_profile.household_id;

  insert into public.laundry_rotation_members (household_id, member_id, rotation_order)
  select acting_profile.household_id, provided.value, provided.position::integer
  from unnest(ordered_member_ids) with ordinality as provided(value, position);
end;
$$;

revoke all on function public.set_laundry_rotation(date, uuid, integer, uuid[]) from public;
grant execute on function public.set_laundry_rotation(date, uuid, integer, uuid[]) to authenticated;
