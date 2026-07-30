-- Casa Cinco — schema, segurança e dados iniciais
create extension if not exists pgcrypto;

create type public.user_role as enum ('admin', 'viewer');
create type public.profile_status as enum ('pending', 'active');
create type public.expense_status as enum ('planned', 'open', 'paid', 'cancelled');
create type public.split_mode as enum ('equal', 'custom');
create type public.share_status as enum ('pending', 'paid', 'late', 'waived');
create type public.recurrence_type as enum ('once', 'monthly');
create type public.chore_frequency as enum ('one_time', 'daily', 'weekly', 'monthly');

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  currency text not null default 'BRL',
  created_at timestamptz not null default now()
);

create table public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  email text unique,
  initials text not null,
  color_key text not null default 'violet',
  is_admin boolean not null default false,
  display_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  role public.user_role not null default 'viewer',
  status public.profile_status not null default 'pending',
  household_id uuid references public.households(id) on delete set null,
  member_id uuid unique references public.household_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  category text not null default 'Outros',
  description text,
  reference_month date not null,
  due_date date,
  amount numeric(12,2),
  estimated boolean not null default false,
  split_mode public.split_mode not null default 'equal',
  status public.expense_status not null default 'planned',
  recurrence public.recurrence_type not null default 'once',
  series_id uuid,
  source_expense_id uuid references public.expenses(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reference_month_first_day check (extract(day from reference_month) = 1),
  constraint amount_nonnegative check (amount is null or amount >= 0)
);

create unique index expenses_series_month_unique
  on public.expenses(household_id, series_id, reference_month)
  where series_id is not null;
create index expenses_household_month_idx on public.expenses(household_id, reference_month);
create index expenses_due_date_idx on public.expenses(household_id, due_date);

create table public.expense_shares (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.household_members(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  payment_status public.share_status not null default 'pending',
  paid_at timestamptz,
  payment_method text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(expense_id, member_id)
);
create index expense_shares_member_idx on public.expense_shares(member_id, payment_status);

create table public.wallet_snapshots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  balance numeric(12,2) not null,
  source text not null check (source in ('manual', 'mercado_pago')),
  external_id text unique,
  observed_at timestamptz not null default now(),
  raw_payload jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index wallet_snapshots_household_idx on public.wallet_snapshots(household_id, observed_at desc);

create table public.chores (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  description text,
  points integer not null default 10 check (points > 0),
  frequency public.chore_frequency not null default 'weekly',
  weekday integer check (weekday is null or weekday between 0 and 6),
  monthday integer check (monthday is null or monthday between 1 and 31),
  due_time time,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.chore_assignments (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid not null references public.chores(id) on delete cascade,
  member_id uuid not null references public.household_members(id) on delete cascade,
  rotation_order integer not null default 0,
  active boolean not null default true,
  unique(chore_id, member_id)
);

create table public.chore_logs (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid not null references public.chores(id) on delete cascade,
  member_id uuid not null references public.household_members(id) on delete cascade,
  reference_date date not null default current_date,
  completed_at timestamptz not null default now(),
  points_awarded integer not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  unique(chore_id, member_id, reference_date)
);
create index chore_logs_household_period_idx on public.chore_logs(reference_date desc);

create table public.system_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  event_type text not null,
  title text not null,
  detail text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute procedure public.set_updated_at();
create trigger expenses_updated_at before update on public.expenses
for each row execute procedure public.set_updated_at();
create trigger shares_updated_at before update on public.expense_shares
for each row execute procedure public.set_updated_at();
create trigger chores_updated_at before update on public.chores
for each row execute procedure public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  matched_member public.household_members%rowtype;
begin
  select * into matched_member
  from public.household_members
  where lower(email) = lower(new.email)
  limit 1;

  insert into public.profiles (id, full_name, email, role, status, household_id, member_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    lower(new.email),
    case when matched_member.is_admin then 'admin'::public.user_role else 'viewer'::public.user_role end,
    case when matched_member.id is not null then 'active'::public.profile_status else 'pending'::public.profile_status end,
    matched_member.household_id,
    matched_member.id
  )
  on conflict (id) do update set
    full_name = excluded.full_name,
    email = excluded.email;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.link_member_profile()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.email is not null then
    update public.profiles
    set member_id = new.id,
        household_id = new.household_id,
        role = case when new.is_admin then 'admin'::public.user_role else 'viewer'::public.user_role end,
        status = 'active'::public.profile_status,
        full_name = new.name
    where lower(email) = lower(new.email);
  end if;
  return new;
end;
$$;

create trigger on_member_email_changed
after insert or update of email, is_admin on public.household_members
for each row execute procedure public.link_member_profile();

create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select household_id from public.profiles
  where id = auth.uid() and status = 'active'
$$;

create or replace function public.current_user_role()
returns public.user_role
language sql
stable
security definer set search_path = public
as $$
  select role from public.profiles
  where id = auth.uid() and status = 'active'
$$;

create or replace function public.is_house_admin(target_household uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select auth.uid() is not null
    and public.current_household_id() = target_household
    and public.current_user_role() = 'admin'::public.user_role
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.profiles enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_shares enable row level security;
alter table public.wallet_snapshots enable row level security;
alter table public.chores enable row level security;
alter table public.chore_assignments enable row level security;
alter table public.chore_logs enable row level security;
alter table public.system_events enable row level security;

create policy households_read on public.households for select to authenticated
using (id = public.current_household_id());
create policy households_admin_update on public.households for update to authenticated
using (public.is_house_admin(id)) with check (public.is_house_admin(id));

create policy members_read on public.household_members for select to authenticated
using (household_id = public.current_household_id());
create policy members_admin_all on public.household_members for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));

create policy profiles_read on public.profiles for select to authenticated
using (id = auth.uid() or (household_id is not null and household_id = public.current_household_id()));
create policy profiles_admin_update on public.profiles for update to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));

create policy expenses_read on public.expenses for select to authenticated
using (household_id = public.current_household_id());
create policy expenses_admin_all on public.expenses for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));

create policy shares_read on public.expense_shares for select to authenticated
using (exists (
  select 1 from public.expenses e
  where e.id = expense_id and e.household_id = public.current_household_id()
));
create policy shares_admin_all on public.expense_shares for all to authenticated
using (exists (
  select 1 from public.expenses e
  where e.id = expense_id and public.is_house_admin(e.household_id)
)) with check (exists (
  select 1 from public.expenses e
  where e.id = expense_id and public.is_house_admin(e.household_id)
));

create policy wallet_read on public.wallet_snapshots for select to authenticated
using (household_id = public.current_household_id());
create policy wallet_admin_all on public.wallet_snapshots for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));

create policy chores_read on public.chores for select to authenticated
using (household_id = public.current_household_id());
create policy chores_admin_all on public.chores for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));

create policy chore_assignments_read on public.chore_assignments for select to authenticated
using (exists (
  select 1 from public.chores c where c.id = chore_id and c.household_id = public.current_household_id()
));
create policy chore_assignments_admin_all on public.chore_assignments for all to authenticated
using (exists (
  select 1 from public.chores c where c.id = chore_id and public.is_house_admin(c.household_id)
)) with check (exists (
  select 1 from public.chores c where c.id = chore_id and public.is_house_admin(c.household_id)
));

create policy chore_logs_read on public.chore_logs for select to authenticated
using (exists (
  select 1 from public.chores c where c.id = chore_id and c.household_id = public.current_household_id()
));
create policy chore_logs_admin_all on public.chore_logs for all to authenticated
using (exists (
  select 1 from public.chores c where c.id = chore_id and public.is_house_admin(c.household_id)
)) with check (exists (
  select 1 from public.chores c where c.id = chore_id and public.is_house_admin(c.household_id)
));

create policy system_events_read on public.system_events for select to authenticated
using (household_id = public.current_household_id());
create policy system_events_admin_all on public.system_events for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));

-- Dados iniciais
insert into public.households (id, name, currency)
values ('11111111-1111-1111-1111-111111111111', 'Casa Cinco', 'BRL');

insert into public.household_members (id, household_id, name, initials, color_key, is_admin, display_order)
values
  ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111111', 'Vitor Gabriel', 'VG', 'violet', true, 1),
  ('11111111-1111-1111-1111-111111111102', '11111111-1111-1111-1111-111111111111', 'Gabriel Belo', 'GB', 'cyan', false, 2),
  ('11111111-1111-1111-1111-111111111103', '11111111-1111-1111-1111-111111111111', 'Savio Patrick', 'SP', 'green', false, 3),
  ('11111111-1111-1111-1111-111111111104', '11111111-1111-1111-1111-111111111111', 'Patrick Camara', 'PC', 'orange', false, 4),
  ('11111111-1111-1111-1111-111111111105', '11111111-1111-1111-1111-111111111111', 'William Martins', 'WM', 'pink', false, 5);

insert into public.expenses
(id, household_id, title, category, description, reference_month, due_date, amount, estimated, split_mode, status, recurrence, series_id)
values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111111', 'Aluguel', 'Moradia', 'Primeiro aluguel, com valor reduzido no mês de entrada.', '2026-08-01', '2026-08-07', 5915.54, false, 'equal', 'open', 'monthly', '22222222-2222-2222-2222-222222222201'),
  ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111111', 'Aluguel', 'Moradia', 'A divisão será personalizada quando os valores individuais forem definidos.', '2026-09-01', '2026-09-07', 6747.00, false, 'custom', 'open', 'monthly', '22222222-2222-2222-2222-222222222201'),
  ('33333333-3333-3333-3333-333333333303', '11111111-1111-1111-1111-111111111111', 'Conta de luz', 'Energia', 'Valor e vencimento ainda serão informados.', '2026-08-01', null, null, true, 'equal', 'planned', 'monthly', '22222222-2222-2222-2222-222222222202'),
  ('33333333-3333-3333-3333-333333333304', '11111111-1111-1111-1111-111111111111', 'Gás', 'Gás', 'Valor e vencimento ainda serão informados.', '2026-08-01', null, null, true, 'equal', 'planned', 'monthly', '22222222-2222-2222-2222-222222222203'),
  ('33333333-3333-3333-3333-333333333305', '11111111-1111-1111-1111-111111111111', 'Internet', 'Internet', 'Valor e vencimento ainda serão informados.', '2026-08-01', null, null, true, 'equal', 'planned', 'monthly', '22222222-2222-2222-2222-222222222204');

insert into public.expense_shares (expense_id, member_id, amount)
values
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111101', 1183.11),
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111102', 1183.11),
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111103', 1183.11),
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111104', 1183.11),
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111105', 1183.10);

insert into public.chores (id, household_id, title, description, points, frequency, weekday, due_time)
values
  ('44444444-4444-4444-4444-444444444401', '11111111-1111-1111-1111-111111111111', 'Limpeza da cozinha', 'Bancadas, fogão, pia e chão.', 25, 'weekly', 6, '12:00'),
  ('44444444-4444-4444-4444-444444444402', '11111111-1111-1111-1111-111111111111', 'Limpeza do banheiro', 'Vaso, box, pia, espelho e chão.', 30, 'weekly', 6, '12:00'),
  ('44444444-4444-4444-4444-444444444403', '11111111-1111-1111-1111-111111111111', 'Sala e áreas comuns', 'Organização, poeira, varrer e passar pano.', 20, 'weekly', 0, '18:00'),
  ('44444444-4444-4444-4444-444444444404', '11111111-1111-1111-1111-111111111111', 'Retirar o lixo', 'Retirar sacos e repor as lixeiras.', 8, 'daily', null, '20:00'),
  ('44444444-4444-4444-4444-444444444405', '11111111-1111-1111-1111-111111111111', 'Conferir itens da casa', 'Verificar produtos de limpeza e itens compartilhados.', 12, 'weekly', 4, '19:00');

insert into public.chore_assignments (chore_id, member_id, rotation_order)
select '44444444-4444-4444-4444-444444444401', id, display_order from public.household_members;
insert into public.chore_assignments (chore_id, member_id, rotation_order)
select '44444444-4444-4444-4444-444444444402', id, display_order from public.household_members;
insert into public.chore_assignments (chore_id, member_id, rotation_order)
select '44444444-4444-4444-4444-444444444403', id, display_order from public.household_members;
insert into public.chore_assignments (chore_id, member_id, rotation_order)
select '44444444-4444-4444-4444-444444444404', id, display_order from public.household_members;
insert into public.chore_assignments (chore_id, member_id, rotation_order)
select '44444444-4444-4444-4444-444444444405', id, display_order from public.household_members;

-- O administrador precisa visualizar perfis pendentes para associá-los aos moradores.
create policy profiles_admin_read_all on public.profiles for select to authenticated
using (public.current_user_role() = 'admin'::public.user_role);
