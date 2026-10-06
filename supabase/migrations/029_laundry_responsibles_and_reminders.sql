-- Responsável por lavagens coletivas e log idempotente dos lembretes da
-- lavanderia. Rode depois da 028_versioned_laundry_rotation.sql.

alter table public.laundry_collective_washes
  add column if not exists responsible_member_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'laundry_collective_washes_responsible_member_fkey'
      and conrelid = 'public.laundry_collective_washes'::regclass
  ) then
    alter table public.laundry_collective_washes
      add constraint laundry_collective_washes_responsible_member_fkey
      foreign key (household_id, responsible_member_id)
      references public.household_members(household_id, id)
      on delete restrict;
  end if;
end;
$$;

-- Registros antigos de roupa de cama podem não ter responsável. A constraint
-- NOT VALID preserva esse histórico, mas já exige o campo em toda nova escrita.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'laundry_collective_bedding_responsible_check'
      and conrelid = 'public.laundry_collective_washes'::regclass
  ) then
    alter table public.laundry_collective_washes
      add constraint laundry_collective_bedding_responsible_check
      check (item_type <> 'bedding' or responsible_member_id is not null)
      not valid;
  end if;
end;
$$;

create index if not exists laundry_collective_responsible_date_idx
  on public.laundry_collective_washes(
    household_id,
    wash_date,
    responsible_member_id
  )
  where responsible_member_id is not null;

create table if not exists public.laundry_reminder_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  reminder_date date not null,
  recipient_email text not null,
  duties jsonb not null default '[]'::jsonb,
  message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, member_id, reminder_date),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade,
  constraint laundry_reminder_log_duties_array_check
    check (jsonb_typeof(duties) = 'array')
);

create index if not exists laundry_reminder_log_period_idx
  on public.laundry_reminder_log(household_id, reminder_date desc);

alter table public.laundry_reminder_log enable row level security;

drop policy if exists laundry_reminder_log_admin_read
  on public.laundry_reminder_log;
create policy laundry_reminder_log_admin_read
on public.laundry_reminder_log for select to authenticated
using (public.is_house_admin(household_id));

drop policy if exists laundry_reminder_log_service_all
  on public.laundry_reminder_log;
create policy laundry_reminder_log_service_all
on public.laundry_reminder_log for all to service_role
using (true) with check (true);
