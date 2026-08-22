-- Escala diária da casa, tarefas padrão e trocas de dia.

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'household_members_household_id_id_key'
      and conrelid = 'public.household_members'::regclass
  ) then
    alter table public.household_members
      add constraint household_members_household_id_id_key unique (household_id, id);
  end if;
end $$;

create table if not exists public.daily_rotation_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  start_date date not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_rotation_members (
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  rotation_order integer not null check (rotation_order > 0),
  created_at timestamptz not null default now(),
  primary key (household_id, member_id),
  unique (household_id, rotation_order),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

create table if not exists public.daily_chore_completions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  reference_date date not null,
  task_key text not null check (task_key in (
    'kitchen_trash',
    'bathroom_1_trash',
    'bathroom_2_trash',
    'bathroom_3_trash',
    'water_bottles'
  )),
  completed_by_member_id uuid not null,
  recorded_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz not null default now(),
  unique (household_id, reference_date, task_key),
  foreign key (household_id, completed_by_member_id)
    references public.household_members(household_id, id) on delete cascade
);
create index if not exists daily_chore_completions_period_idx
  on public.daily_chore_completions(household_id, reference_date);

create table if not exists public.chore_day_swap_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  requester_member_id uuid not null,
  requester_date date not null,
  target_member_id uuid not null,
  target_date date not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  constraint chore_day_swap_distinct_dates check (requester_date <> target_date),
  constraint chore_day_swap_distinct_members check (requester_member_id <> target_member_id),
  foreign key (household_id, requester_member_id)
    references public.household_members(household_id, id) on delete cascade,
  foreign key (household_id, target_member_id)
    references public.household_members(household_id, id) on delete cascade
);
create index if not exists chore_day_swap_household_status_idx
  on public.chore_day_swap_requests(household_id, status, created_at desc);

alter table public.daily_rotation_settings enable row level security;
alter table public.daily_rotation_members enable row level security;
alter table public.daily_chore_completions enable row level security;
alter table public.chore_day_swap_requests enable row level security;

create policy daily_rotation_settings_read on public.daily_rotation_settings
for select to authenticated
using (household_id = public.current_household_id());

create policy daily_rotation_settings_admin_all on public.daily_rotation_settings
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

create policy daily_rotation_members_read on public.daily_rotation_members
for select to authenticated
using (household_id = public.current_household_id());

create policy daily_rotation_members_admin_all on public.daily_rotation_members
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

create policy daily_chore_completions_read on public.daily_chore_completions
for select to authenticated
using (household_id = public.current_household_id());

create policy daily_chore_completions_admin_all on public.daily_chore_completions
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

create policy chore_day_swap_requests_read on public.chore_day_swap_requests
for select to authenticated
using (household_id = public.current_household_id());

create policy chore_day_swap_requests_admin_all on public.chore_day_swap_requests
for all to authenticated
using (public.is_house_admin(household_id))
with check (public.is_house_admin(household_id));

-- A ordem inicial segue a ordem já usada na tela de moradores. A escala
-- começa no dia seguinte à aplicação desta migração.
insert into public.daily_rotation_settings (household_id, start_date)
select id, ((now() at time zone 'America/Sao_Paulo')::date + 1)
from public.households
on conflict (household_id) do nothing;

insert into public.daily_rotation_members (household_id, member_id, rotation_order)
select
  member.household_id,
  member.id,
  row_number() over (
    partition by member.household_id
    order by member.display_order, member.created_at, member.id
  )::integer
from public.household_members member
where member.active = true
on conflict (household_id, member_id) do nothing;

create or replace function public.daily_rotation_assignee(
  target_household uuid,
  assignment_date date
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  configured_start date;
  assigned_member uuid;
  member_count integer;
  day_offset integer;
begin
  if auth.role() <> 'service_role'
    and target_household is distinct from public.current_household_id() then
    return null;
  end if;

  select start_date
    into configured_start
  from public.daily_rotation_settings
  where household_id = target_household;

  if configured_start is null or assignment_date < configured_start then
    return null;
  end if;

  select case
      when swap.requester_date = assignment_date then swap.target_member_id
      else swap.requester_member_id
    end
    into assigned_member
  from public.chore_day_swap_requests swap
  where swap.household_id = target_household
    and swap.status = 'approved'
    and (swap.requester_date = assignment_date or swap.target_date = assignment_date)
  order by swap.reviewed_at desc nulls last
  limit 1;

  if assigned_member is not null then
    return assigned_member;
  end if;

  select count(*)::integer
    into member_count
  from public.daily_rotation_members rotation
  join public.household_members member on member.id = rotation.member_id
  where rotation.household_id = target_household
    and member.active = true;

  if member_count = 0 then
    return null;
  end if;

  day_offset := (assignment_date - configured_start) % member_count;

  select rotation.member_id
    into assigned_member
  from public.daily_rotation_members rotation
  join public.household_members member on member.id = rotation.member_id
  where rotation.household_id = target_household
    and member.active = true
  order by rotation.rotation_order
  offset day_offset
  limit 1;

  return assigned_member;
end;
$$;

create or replace function public.set_daily_rotation(
  rotation_start_date date,
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
    raise exception 'Somente o administrador pode configurar a escala.';
  end if;
  if rotation_start_date is null then
    raise exception 'Informe a data de início da escala.';
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

  insert into public.daily_rotation_settings (household_id, start_date, updated_by, updated_at)
  values (acting_profile.household_id, rotation_start_date, acting_profile.id, now())
  on conflict (household_id) do update
  set start_date = excluded.start_date,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  delete from public.daily_rotation_members
  where household_id = acting_profile.household_id;

  insert into public.daily_rotation_members (household_id, member_id, rotation_order)
  select acting_profile.household_id, provided.value, provided.position::integer
  from unnest(ordered_member_ids) with ordinality as provided(value, position);

  update public.chore_day_swap_requests
  set status = 'rejected',
      reviewed_by = acting_profile.id,
      reviewed_at = now(),
      review_note = 'Cancelada automaticamente porque a ordem da escala foi alterada.'
  where household_id = acting_profile.household_id
    and status = 'pending';
end;
$$;

create or replace function public.request_chore_day_swap(
  target_requester_date date,
  target_target_date date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  requester_assignee uuid;
  target_assignee uuid;
  request_id uuid;
  local_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null
    and member_id is not null;

  if acting_profile.id is null then
    raise exception 'Seu usuário precisa estar vinculado a um morador ativo.';
  end if;
  if target_requester_date <= local_today or target_target_date <= local_today then
    raise exception 'A troca só pode envolver dias futuros.';
  end if;
  if target_target_date <= target_requester_date then
    raise exception 'Escolha um dia posterior ao seu para realizar a troca.';
  end if;
  if exists (
    select 1
    from public.chore_day_swap_requests swap
    where swap.household_id = acting_profile.household_id
      and swap.status in ('pending', 'approved')
      and (
        swap.requester_date in (target_requester_date, target_target_date)
        or swap.target_date in (target_requester_date, target_target_date)
      )
  ) then
    raise exception 'Um dos dias já participa de outra solicitação de troca.';
  end if;

  requester_assignee := public.daily_rotation_assignee(
    acting_profile.household_id,
    target_requester_date
  );
  target_assignee := public.daily_rotation_assignee(
    acting_profile.household_id,
    target_target_date
  );

  if requester_assignee is distinct from acting_profile.member_id then
    raise exception 'Você só pode solicitar a troca de um dia atribuído a você.';
  end if;
  if target_assignee is null or target_assignee = requester_assignee then
    raise exception 'Escolha um dia futuro atribuído a outro morador.';
  end if;

  insert into public.chore_day_swap_requests (
    household_id,
    requester_member_id,
    requester_date,
    target_member_id,
    target_date
  ) values (
    acting_profile.household_id,
    acting_profile.member_id,
    target_requester_date,
    target_assignee,
    target_target_date
  )
  returning id into request_id;

  return request_id;
end;
$$;

create or replace function public.review_chore_day_swap(
  target_request_id uuid,
  approve_request boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  swap_request public.chore_day_swap_requests%rowtype;
  local_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode analisar trocas.';
  end if;

  select * into swap_request
  from public.chore_day_swap_requests
  where id = target_request_id
    and household_id = acting_profile.household_id
    and status = 'pending'
  for update;

  if swap_request.id is null then
    raise exception 'Solicitação pendente não encontrada.';
  end if;

  if not approve_request then
    update public.chore_day_swap_requests
    set status = 'rejected',
        reviewed_by = acting_profile.id,
        reviewed_at = now(),
        review_note = 'Solicitação recusada pelo administrador.'
    where id = swap_request.id;
    return;
  end if;

  if swap_request.requester_date <= local_today or swap_request.target_date <= local_today then
    raise exception 'Esta solicitação venceu porque uma das datas não é mais futura.';
  end if;
  if exists (
    select 1
    from public.chore_day_swap_requests other
    where other.household_id = acting_profile.household_id
      and other.id <> swap_request.id
      and other.status = 'approved'
      and (
        other.requester_date in (swap_request.requester_date, swap_request.target_date)
        or other.target_date in (swap_request.requester_date, swap_request.target_date)
      )
  ) then
    raise exception 'Um dos dias já foi usado em outra troca aprovada.';
  end if;
  if public.daily_rotation_assignee(acting_profile.household_id, swap_request.requester_date)
      is distinct from swap_request.requester_member_id
    or public.daily_rotation_assignee(acting_profile.household_id, swap_request.target_date)
      is distinct from swap_request.target_member_id then
    raise exception 'A escala mudou desde a solicitação. Recuse este pedido e solicite uma nova troca.';
  end if;

  update public.chore_day_swap_requests
  set status = 'approved',
      reviewed_by = acting_profile.id,
      reviewed_at = now(),
      review_note = 'Troca aprovada pelo administrador.'
  where id = swap_request.id;
end;
$$;

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
  if target_task_key not in (
    'kitchen_trash',
    'bathroom_1_trash',
    'bathroom_2_trash',
    'bathroom_3_trash',
    'water_bottles'
  ) then
    raise exception 'Tarefa padrão inválida.';
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

create or replace function public.record_daily_extra_task(
  target_date date,
  task_title text,
  task_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  assigned_member uuid;
  new_task_id uuid;
  clean_title text := nullif(trim(task_title), '');
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
  if clean_title is null then
    raise exception 'Informe o nome da tarefa realizada.';
  end if;
  if target_date > local_today then
    raise exception 'Não é possível registrar como feita uma tarefa futura.';
  end if;

  assigned_member := public.daily_rotation_assignee(acting_profile.household_id, target_date);
  if assigned_member is null then
    raise exception 'Este dia ainda não faz parte da escala.';
  end if;
  if acting_profile.role <> 'admin'::public.user_role
    and acting_profile.member_id is distinct from assigned_member then
    raise exception 'Somente o responsável do dia pode registrar tarefas extras.';
  end if;

  insert into public.tasks (
    household_id,
    scope,
    title,
    description,
    due_date,
    source,
    created_by
  ) values (
    acting_profile.household_id,
    'casa'::public.task_scope,
    clean_title,
    nullif(trim(task_description), ''),
    target_date,
    'manual',
    acting_profile.id
  )
  returning id into new_task_id;

  insert into public.task_assignees (task_id, member_id, done, done_at)
  values (new_task_id, assigned_member, true, now());

  return new_task_id;
end;
$$;

revoke all on function public.daily_rotation_assignee(uuid, date) from public;
revoke all on function public.set_daily_rotation(date, uuid[]) from public;
revoke all on function public.request_chore_day_swap(date, date) from public;
revoke all on function public.review_chore_day_swap(uuid, boolean) from public;
revoke all on function public.toggle_daily_chore_completion(date, text, boolean) from public;
revoke all on function public.record_daily_extra_task(date, text, text) from public;

grant execute on function public.daily_rotation_assignee(uuid, date) to authenticated;
grant execute on function public.set_daily_rotation(date, uuid[]) to authenticated;
grant execute on function public.request_chore_day_swap(date, date) to authenticated;
grant execute on function public.review_chore_day_swap(uuid, boolean) to authenticated;
grant execute on function public.toggle_daily_chore_completion(date, text, boolean) to authenticated;
grant execute on function public.record_daily_extra_task(date, text, text) to authenticated;
