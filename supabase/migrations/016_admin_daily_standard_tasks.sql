-- Tarefas padrão diárias configuráveis pelo administrador.

create table if not exists public.daily_standard_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  task_key text not null,
  label text not null check (char_length(trim(label)) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  display_order integer not null check (display_order > 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, task_key)
);

create index if not exists daily_standard_tasks_household_order_idx
  on public.daily_standard_tasks(household_id, active desc, display_order, created_at);

alter table public.daily_standard_tasks enable row level security;

drop policy if exists daily_standard_tasks_read on public.daily_standard_tasks;
create policy daily_standard_tasks_read on public.daily_standard_tasks
for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists daily_standard_tasks_admin_all on public.daily_standard_tasks;
create policy daily_standard_tasks_admin_all on public.daily_standard_tasks
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

-- Mantém as cinco tarefas que já existiam no sistema e preserva as
-- conclusões registradas com as chaves antigas.
insert into public.daily_standard_tasks (
  household_id,
  task_key,
  label,
  display_order
)
select household.id, defaults.task_key, defaults.label, defaults.display_order
from public.households household
cross join (
  values
    ('kitchen_trash', 'Verificar o lixo da cozinha', 1),
    ('bathroom_1_trash', 'Verificar o lixo do banheiro 1', 2),
    ('bathroom_2_trash', 'Verificar o lixo do banheiro 2', 3),
    ('bathroom_3_trash', 'Verificar o lixo do banheiro 3', 4),
    ('water_bottles', 'Encher as garrafas de água', 5)
) as defaults(task_key, label, display_order)
on conflict (household_id, task_key) do nothing;

alter table public.daily_chore_completions
  drop constraint if exists daily_chore_completions_task_key_check;

do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'daily_chore_completions_standard_task_fkey'
      and conrelid = 'public.daily_chore_completions'::regclass
  ) then
    alter table public.daily_chore_completions
      add constraint daily_chore_completions_standard_task_fkey
      foreign key (household_id, task_key)
      references public.daily_standard_tasks(household_id, task_key)
      on update cascade
      on delete restrict;
  end if;
end $$;

-- Substitui a validação fixa da migração 015 pela lista configurada da casa.
create or replace function public.toggle_daily_chore_completion(
  target_date date,
  target_task_key text,
  mark_completed boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  assigned_member uuid;
  local_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null then
    raise exception 'Usuário ativo não encontrado.';
  end if;
  if not exists (
    select 1
    from public.daily_standard_tasks task
    where task.household_id = acting_profile.household_id
      and task.task_key = target_task_key
      and (task.active = true or mark_completed = false)
  ) then
    raise exception 'Tarefa padrão inválida ou desativada.';
  end if;
  if target_date > local_today then
    raise exception 'Não é possível concluir uma tarefa de um dia futuro.';
  end if;

  assigned_member := public.daily_rotation_assignee(acting_profile.household_id, target_date);
  if assigned_member is null then
    raise exception 'Este dia ainda não faz parte da escala.';
  end if;
  if acting_profile.role <> 'admin'::public.user_role
    and acting_profile.member_id is distinct from assigned_member then
    raise exception 'Somente o responsável do dia pode alterar estas tarefas.';
  end if;

  if mark_completed then
    insert into public.daily_chore_completions (
      household_id,
      reference_date,
      task_key,
      completed_by_member_id,
      recorded_by,
      completed_at
    ) values (
      acting_profile.household_id,
      target_date,
      target_task_key,
      assigned_member,
      acting_profile.id,
      now()
    )
    on conflict (household_id, reference_date, task_key) do update
    set completed_by_member_id = excluded.completed_by_member_id,
        recorded_by = excluded.recorded_by,
        completed_at = excluded.completed_at;
  else
    delete from public.daily_chore_completions
    where household_id = acting_profile.household_id
      and reference_date = target_date
      and task_key = target_task_key;
  end if;
end;
$$;

revoke all on function public.toggle_daily_chore_completion(date, text, boolean) from public;
grant execute on function public.toggle_daily_chore_completion(date, text, boolean) to authenticated;
