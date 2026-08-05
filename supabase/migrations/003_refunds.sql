-- Casa Cinco — Tabela de reembolsos
create type public.refund_status as enum (
  'a_solicitar',
  'solicitado',
  'recebido',
  'distribuido',
  'compensado'
);

create table public.expense_refunds (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  -- dados do reembolso
  total_amount numeric(12,2) not null check (total_amount >= 0),
  description text,
  responsible_entity text,
  due_date date,
  reference text,
  -- status e datas
  status public.refund_status not null default 'a_solicitar',
  requested_at timestamptz,
  received_at timestamptz,
  received_amount numeric(12,2),
  distributed_at timestamptz,
  -- controle individual por morador
  members_data jsonb not null default '{}'::jsonb,
  -- auditoria
  requested_by uuid references auth.users(id),
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- validação: received_amount <= total_amount
  constraint received_not_greater check (
    received_amount is null or received_amount <= total_amount
  )
);

create index expense_refunds_expense_idx on public.expense_refunds(expense_id);
create index expense_refunds_household_idx on public.expense_refunds(household_id);
create index expense_refunds_status_idx on public.expense_refunds(status);

create trigger expense_refunds_updated_at before update on public.expense_refunds
  for each row execute procedure public.set_updated_at();

-- Tabela para tarefas gerais vinculadas a reembolsos
create table public.tasks_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  description text,
  due_date date,
  assigned_to uuid[] not null default '{}',
  priority text not null default 'normal',
  status text not null default 'pending',
  created_by uuid not null references auth.users(id),
  completed_by uuid references auth.users(id),
  expense_refund_id uuid references public.expense_refunds(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  members_data jsonb not null default '{}'::jsonb
);

create index tasks_tasks_household_idx on public.tasks_tasks(household_id);
create index tasks_tasks_expense_refund_idx on public.tasks_tasks(expense_refund_id);

create trigger tasks_tasks_updated_at before update on public.tasks_tasks
  for each row execute procedure public.set_updated_at();
