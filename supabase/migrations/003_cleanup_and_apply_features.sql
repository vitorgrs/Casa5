-- Casa Cinco — limpeza das tabelas criadas manualmente que a aplicação NÃO
-- usa (user_permissions, expense_refunds) e aplicação da migração 002 com
-- o modelo de permissões/reembolso que o código realmente lê e escreve.
--
-- Rode este arquivo inteiro de uma vez no SQL Editor do Supabase, depois do
-- 001_initial.sql. Ele substitui a necessidade de rodar 002_features.sql
-- separadamente (o conteúdo dela está incluído aqui).
--
-- Resultado: o banco fica só com o que a aplicação usa. Nenhuma dessas
-- tabelas/colunas antigas é referenciada em nenhuma consulta do código, por
-- isso é seguro apagá-las.

-- ============================================================
-- 0) Reverter mudanças manuais desnecessárias
-- ============================================================
drop table if exists public.expense_refunds cascade;
drop table if exists public.user_permissions cascade;
drop type if exists public.refund_status cascade;

-- ============================================================
-- 1) Colunas novas usadas pela aplicação
-- ============================================================
alter table public.profiles
  add column if not exists permissions jsonb not null default '{}'::jsonb;

alter table public.household_members
  add column if not exists pix_key text;

alter table public.expenses
  add column if not exists has_reimbursement boolean not null default false,
  add column if not exists reimbursement_amount numeric(12,2);

alter table public.expense_shares
  add column if not exists reimbursement_status text not null default 'not_applicable',
  add column if not exists reimbursement_paid_at timestamptz;

alter table public.expense_shares
  drop constraint if exists expense_shares_reimbursement_status_check;
alter table public.expense_shares
  add constraint expense_shares_reimbursement_status_check
  check (reimbursement_status in ('not_applicable', 'pending', 'paid'));

-- ============================================================
-- 2) Configurações da casa (lembretes por e-mail)
-- ============================================================
create table if not exists public.household_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  reminders_enabled boolean not null default true,
  reminder_days_before integer not null default 3,
  updated_at timestamptz not null default now()
);

insert into public.household_settings (household_id)
values ('11111111-1111-1111-1111-111111111111')
on conflict (household_id) do nothing;

create table if not exists public.expense_reminder_log (
  id uuid primary key default gen_random_uuid(),
  expense_share_id uuid not null references public.expense_shares(id) on delete cascade,
  reminder_date date not null default current_date,
  sent_at timestamptz not null default now(),
  unique(expense_share_id, reminder_date)
);

-- ============================================================
-- 3) Organização: tarefas delegadas + agenda do "Casa em dia"
-- ============================================================
do $$ begin
  create type public.task_scope as enum ('casa', 'geral');
exception when duplicate_object then null; end $$;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  scope public.task_scope not null default 'geral',
  title text not null,
  description text,
  due_date date,
  source text not null default 'manual' check (source in ('manual', 'reimbursement')),
  source_expense_id uuid references public.expenses(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_household_idx on public.tasks(household_id, scope, due_date);

create table if not exists public.task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  member_id uuid not null references public.household_members(id) on delete cascade,
  done boolean not null default false,
  done_at timestamptz,
  unique(task_id, member_id)
);
create index if not exists task_assignees_member_idx on public.task_assignees(member_id, done);

-- ============================================================
-- 4) Lista de compras
-- ============================================================
do $$ begin
  create type public.shopping_status as enum ('list', 'checked', 'bought');
exception when duplicate_object then null; end $$;

create table if not exists public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  note text,
  category text,
  status public.shopping_status not null default 'list',
  quantity_planned numeric(10,2),
  quantity_bought numeric(10,2),
  unit_price numeric(12,2),
  added_by uuid references auth.users(id) on delete set null,
  checked_at timestamptz,
  bought_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shopping_items_household_idx on public.shopping_items(household_id, status);

-- ============================================================
-- 5) Permissões granulares
-- ============================================================
-- Chaves usadas em profiles.permissions (todas boolean, padrão false):
--   manage_expenses, mark_expenses_paid, view_wallet_balance,
--   manage_chores, manage_tasks, manage_shopping, manage_members
-- Administradores sempre têm acesso total, independente do jsonb.

create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (
      select p.role = 'admin'::public.user_role
        or coalesce((p.permissions ->> perm)::boolean, false)
      from public.profiles p
      where p.id = auth.uid()
        and p.household_id = public.current_household_id()
    ),
    false
  )
$$;

-- ============================================================
-- 6) RLS das tabelas novas
-- ============================================================
alter table public.household_settings enable row level security;
alter table public.expense_reminder_log enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;
alter table public.shopping_items enable row level security;

drop policy if exists household_settings_read on public.household_settings;
create policy household_settings_read on public.household_settings for select to authenticated
using (household_id = public.current_household_id());
drop policy if exists household_settings_admin_all on public.household_settings;
create policy household_settings_admin_all on public.household_settings for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));

drop policy if exists reminder_log_read on public.expense_reminder_log;
create policy reminder_log_read on public.expense_reminder_log for select to authenticated
using (exists (
  select 1 from public.expense_shares s
  join public.expenses e on e.id = s.expense_id
  where s.id = expense_share_id and e.household_id = public.current_household_id()
));
drop policy if exists reminder_log_service_all on public.expense_reminder_log;
create policy reminder_log_service_all on public.expense_reminder_log for all to service_role
using (true) with check (true);

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
using (household_id = public.current_household_id());
drop policy if exists tasks_admin_all on public.tasks;
create policy tasks_admin_all on public.tasks for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));
drop policy if exists tasks_permission_write on public.tasks;
create policy tasks_permission_write on public.tasks for insert to authenticated
with check (household_id = public.current_household_id() and public.has_permission('manage_tasks'));
drop policy if exists tasks_permission_update on public.tasks;
create policy tasks_permission_update on public.tasks for update to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_tasks'))
with check (household_id = public.current_household_id() and public.has_permission('manage_tasks'));
drop policy if exists tasks_permission_delete on public.tasks;
create policy tasks_permission_delete on public.tasks for delete to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_tasks'));

drop policy if exists task_assignees_read on public.task_assignees;
create policy task_assignees_read on public.task_assignees for select to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and t.household_id = public.current_household_id()));
drop policy if exists task_assignees_admin_all on public.task_assignees;
create policy task_assignees_admin_all on public.task_assignees for all to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and public.is_house_admin(t.household_id)))
with check (exists (select 1 from public.tasks t where t.id = task_id and public.is_house_admin(t.household_id)));
drop policy if exists task_assignees_permission_write on public.task_assignees;
create policy task_assignees_permission_write on public.task_assignees for insert to authenticated
with check (exists (select 1 from public.tasks t where t.id = task_id and t.household_id = public.current_household_id() and public.has_permission('manage_tasks')));
drop policy if exists task_assignees_permission_update on public.task_assignees;
create policy task_assignees_permission_update on public.task_assignees for update to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and t.household_id = public.current_household_id() and public.has_permission('manage_tasks')))
with check (exists (select 1 from public.tasks t where t.id = task_id and t.household_id = public.current_household_id() and public.has_permission('manage_tasks')));
drop policy if exists task_assignees_self_update on public.task_assignees;
-- qualquer morador pode marcar a própria atribuição como concluída
create policy task_assignees_self_update on public.task_assignees for update to authenticated
using (member_id = (select member_id from public.profiles where id = auth.uid()))
with check (member_id = (select member_id from public.profiles where id = auth.uid()));

drop policy if exists shopping_read on public.shopping_items;
create policy shopping_read on public.shopping_items for select to authenticated
using (household_id = public.current_household_id());
drop policy if exists shopping_admin_all on public.shopping_items;
create policy shopping_admin_all on public.shopping_items for all to authenticated
using (public.is_house_admin(household_id)) with check (public.is_house_admin(household_id));
drop policy if exists shopping_permission_write on public.shopping_items;
create policy shopping_permission_write on public.shopping_items for insert to authenticated
with check (household_id = public.current_household_id() and public.has_permission('manage_shopping'));
drop policy if exists shopping_permission_update on public.shopping_items;
create policy shopping_permission_update on public.shopping_items for update to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_shopping'))
with check (household_id = public.current_household_id() and public.has_permission('manage_shopping'));
drop policy if exists shopping_permission_delete on public.shopping_items;
create policy shopping_permission_delete on public.shopping_items for delete to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_shopping'));

-- ============================================================
-- 7) Ajustes de RLS existentes para respeitar permissões granulares
-- ============================================================
drop policy if exists expenses_permission_write on public.expenses;
create policy expenses_permission_write on public.expenses for insert to authenticated
with check (household_id = public.current_household_id() and public.has_permission('manage_expenses'));
drop policy if exists expenses_permission_update on public.expenses;
create policy expenses_permission_update on public.expenses for update to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_expenses'))
with check (household_id = public.current_household_id() and public.has_permission('manage_expenses'));

drop policy if exists shares_permission_write on public.expense_shares;
create policy shares_permission_write on public.expense_shares for insert to authenticated
with check (exists (
  select 1 from public.expenses e
  where e.id = expense_id and e.household_id = public.current_household_id()
    and public.has_permission('manage_expenses')
));
drop policy if exists shares_permission_update on public.expense_shares;
create policy shares_permission_update on public.expense_shares for update to authenticated
using (exists (
  select 1 from public.expenses e
  where e.id = expense_id and e.household_id = public.current_household_id()
    and (public.has_permission('manage_expenses') or public.has_permission('mark_expenses_paid'))
))
with check (exists (
  select 1 from public.expenses e
  where e.id = expense_id and e.household_id = public.current_household_id()
    and (public.has_permission('manage_expenses') or public.has_permission('mark_expenses_paid'))
));

drop policy if exists wallet_read on public.wallet_snapshots;
drop policy if exists wallet_read_permission on public.wallet_snapshots;
create policy wallet_read_permission on public.wallet_snapshots for select to authenticated
using (household_id = public.current_household_id() and public.has_permission('view_wallet_balance'));

drop policy if exists chores_permission_write on public.chores;
create policy chores_permission_write on public.chores for insert to authenticated
with check (household_id = public.current_household_id() and public.has_permission('manage_chores'));
drop policy if exists chores_permission_update on public.chores;
create policy chores_permission_update on public.chores for update to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_chores'))
with check (household_id = public.current_household_id() and public.has_permission('manage_chores'));
drop policy if exists chore_assignments_permission_write on public.chore_assignments;
create policy chore_assignments_permission_write on public.chore_assignments for insert to authenticated
with check (exists (select 1 from public.chores c where c.id = chore_id and c.household_id = public.current_household_id() and public.has_permission('manage_chores')));
drop policy if exists chore_logs_permission_write on public.chore_logs;
create policy chore_logs_permission_write on public.chore_logs for insert to authenticated
with check (exists (select 1 from public.chores c where c.id = chore_id and c.household_id = public.current_household_id() and public.has_permission('manage_chores')));

drop policy if exists members_permission_update on public.household_members;
create policy members_permission_update on public.household_members for update to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_members'))
with check (household_id = public.current_household_id() and public.has_permission('manage_members'));
