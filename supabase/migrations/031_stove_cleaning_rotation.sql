-- Rodizio manual de limpeza do fogao. Nao existe prazo automatico: o estado
-- avanca somente quando um morador confirma que a pessoa da vez concluiu a
-- limpeza. Rode depois da 030_water_gallon_rotation.sql.

create table if not exists public.stove_cleaning_rotation_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  current_member_id uuid references public.household_members(id) on delete set null,
  current_since timestamptz not null default now(),
  turn_number bigint not null default 1 check (turn_number > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.stove_cleaning_rotation_members (
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  rotation_order integer not null check (rotation_order > 0),
  created_at timestamptz not null default now(),
  primary key (household_id, member_id),
  unique (household_id, rotation_order),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

-- O numero do turno identifica uma passagem especifica pelo rodizio. A
-- restricao unica impede duas confirmacoes do mesmo turno mesmo sob cliques
-- concorrentes. Os nomes sao snapshots para preservar o historico.
create table if not exists public.stove_cleaning_history (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  turn_number bigint not null check (turn_number > 0),
  member_id uuid references public.household_members(id) on delete set null,
  member_name_snapshot text not null,
  cleaned_at timestamptz not null default now(),
  next_member_id uuid references public.household_members(id) on delete set null,
  next_member_name_snapshot text not null,
  confirmed_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  unique (household_id, turn_number)
);

-- Auditoria separada das alteracoes administrativas. Os UUIDs dos moradores
-- nao possuem FK de proposito, para o registro sobreviver a futuras remocoes.
create table if not exists public.stove_cleaning_rotation_changes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  change_type text not null check (
    change_type in ('initialized', 'order_updated', 'current_member_changed')
  ),
  previous_current_member_id uuid,
  current_member_id uuid,
  previous_ordered_member_ids uuid[] not null default array[]::uuid[],
  ordered_member_ids uuid[] not null default array[]::uuid[],
  note text,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists stove_cleaning_rotation_members_order_idx
  on public.stove_cleaning_rotation_members(household_id, rotation_order);
create index if not exists stove_cleaning_history_household_idx
  on public.stove_cleaning_history(household_id, cleaned_at desc, created_at desc);
create index if not exists stove_cleaning_rotation_changes_household_idx
  on public.stove_cleaning_rotation_changes(household_id, changed_at desc);

alter table public.stove_cleaning_rotation_settings enable row level security;
alter table public.stove_cleaning_rotation_members enable row level security;
alter table public.stove_cleaning_history enable row level security;
alter table public.stove_cleaning_rotation_changes enable row level security;

drop policy if exists stove_cleaning_rotation_settings_read
  on public.stove_cleaning_rotation_settings;
create policy stove_cleaning_rotation_settings_read
on public.stove_cleaning_rotation_settings for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists stove_cleaning_rotation_members_read
  on public.stove_cleaning_rotation_members;
create policy stove_cleaning_rotation_members_read
on public.stove_cleaning_rotation_members for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists stove_cleaning_history_read
  on public.stove_cleaning_history;
create policy stove_cleaning_history_read
on public.stove_cleaning_history for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists stove_cleaning_rotation_changes_read
  on public.stove_cleaning_rotation_changes;
create policy stove_cleaning_rotation_changes_read
on public.stove_cleaning_rotation_changes for select to authenticated
using (household_id = public.current_household_id());

-- O cliente le o estado, mas todas as escritas passam pelas funcoes abaixo.
-- Elas verificam o perfil e atualizam estado e historico na mesma transacao.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.stove_cleaning_rotation_settings from anon;
    revoke all on table public.stove_cleaning_rotation_members from anon;
    revoke all on table public.stove_cleaning_history from anon;
    revoke all on table public.stove_cleaning_rotation_changes from anon;
  end if;
end;
$$;

revoke all on table public.stove_cleaning_rotation_settings from authenticated;
revoke all on table public.stove_cleaning_rotation_members from authenticated;
revoke all on table public.stove_cleaning_history from authenticated;
revoke all on table public.stove_cleaning_rotation_changes from authenticated;
grant select on table public.stove_cleaning_rotation_settings to authenticated;
grant select on table public.stove_cleaning_rotation_members to authenticated;
grant select on table public.stove_cleaning_history to authenticated;
grant select on table public.stove_cleaning_rotation_changes to authenticated;

create or replace function public.next_stove_cleaning_member(
  target_household_id uuid,
  after_member_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  with current_position as (
    select rotation.rotation_order
    from public.stove_cleaning_rotation_members rotation
    where rotation.household_id = target_household_id
      and rotation.member_id = after_member_id
  )
  select rotation.member_id
  from public.stove_cleaning_rotation_members rotation
  join public.household_members member
    on member.household_id = rotation.household_id
   and member.id = rotation.member_id
   and member.active = true
  cross join current_position
  where rotation.household_id = target_household_id
  order by
    case when rotation.rotation_order > current_position.rotation_order then 0 else 1 end,
    rotation.rotation_order
  limit 1;
$$;

revoke all on function public.next_stove_cleaning_member(uuid, uuid) from public;

-- A ordem pode conter qualquer subconjunto de moradores ativos, mas precisa
-- ter pelo menos duas pessoas para formar um rodizio e permitir que a pessoa
-- esperada funcione tambem como protecao idempotente.
create or replace function public.set_stove_cleaning_rotation(
  ordered_member_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  provided_member_count integer;
  distinct_member_count integer;
  previous_current_member_id uuid;
  resolved_current_member_id uuid;
  previous_current_since timestamptz;
  previous_turn_number bigint;
  previous_ordered_member_ids uuid[];
  settings_exist boolean;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode configurar o rodizio do fogao.';
  end if;

  select count(*)::integer, count(distinct provided.member_id)::integer
    into provided_member_count, distinct_member_count
  from unnest(coalesce(ordered_member_ids, array[]::uuid[]))
    as provided(member_id);

  if provided_member_count < 2 then
    raise exception 'O rodizio do fogao precisa ter pelo menos duas pessoas.';
  end if;
  if distinct_member_count <> provided_member_count then
    raise exception 'Cada pessoa pode aparecer apenas uma vez na ordem.';
  end if;
  if exists (
    select 1
    from unnest(ordered_member_ids) as provided(member_id)
    where not exists (
      select 1
      from public.household_members member
      where member.household_id = acting_profile.household_id
        and member.id = provided.member_id
        and member.active = true
    )
  ) then
    raise exception 'A ordem contem um morador invalido ou inativo.';
  end if;

  -- Serializa configuracoes e confirmacoes da mesma casa, inclusive antes de
  -- a linha de configuracao existir.
  perform 1
  from public.households household
  where household.id = acting_profile.household_id
  for update;

  select
    settings.current_member_id,
    settings.current_since,
    settings.turn_number
  into
    previous_current_member_id,
    previous_current_since,
    previous_turn_number
  from public.stove_cleaning_rotation_settings settings
  where settings.household_id = acting_profile.household_id;
  settings_exist := found;

  select coalesce(
    array_agg(rotation.member_id order by rotation.rotation_order),
    array[]::uuid[]
  )
  into previous_ordered_member_ids
  from public.stove_cleaning_rotation_members rotation
  where rotation.household_id = acting_profile.household_id;

  resolved_current_member_id := case
    when previous_current_member_id = any(ordered_member_ids)
      then previous_current_member_id
    else ordered_member_ids[1]
  end;

  if settings_exist
    and previous_current_member_id is not distinct from resolved_current_member_id
    and previous_ordered_member_ids = ordered_member_ids then
    return;
  end if;

  insert into public.stove_cleaning_rotation_settings (
    household_id,
    current_member_id,
    current_since,
    turn_number,
    updated_by,
    updated_at
  ) values (
    acting_profile.household_id,
    resolved_current_member_id,
    case
      when previous_current_member_id is not distinct from resolved_current_member_id
        then coalesce(previous_current_since, now())
      else now()
    end,
    case
      when not settings_exist then 1
      else previous_turn_number + 1
    end,
    acting_profile.id,
    now()
  )
  on conflict (household_id) do update
  set current_member_id = excluded.current_member_id,
      current_since = excluded.current_since,
      turn_number = excluded.turn_number,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  delete from public.stove_cleaning_rotation_members
  where household_id = acting_profile.household_id;

  insert into public.stove_cleaning_rotation_members (
    household_id,
    member_id,
    rotation_order
  )
  select
    acting_profile.household_id,
    provided.member_id,
    provided.position::integer
  from unnest(ordered_member_ids) with ordinality
    as provided(member_id, position);

  insert into public.stove_cleaning_rotation_changes (
    household_id,
    change_type,
    previous_current_member_id,
    current_member_id,
    previous_ordered_member_ids,
    ordered_member_ids,
    changed_by
  ) values (
    acting_profile.household_id,
    'order_updated',
    previous_current_member_id,
    resolved_current_member_id,
    coalesce(previous_ordered_member_ids, array[]::uuid[]),
    ordered_member_ids,
    acting_profile.id
  );
end;
$$;

revoke all on function public.set_stove_cleaning_rotation(uuid[]) from public;
grant execute on function public.set_stove_cleaning_rotation(uuid[]) to authenticated;

create or replace function public.set_stove_cleaning_current_member(
  target_member_id uuid,
  change_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  previous_member_id uuid;
  ordered_ids uuid[];
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode alterar a pessoa da vez.';
  end if;
  if target_member_id is null then
    raise exception 'Selecione a pessoa da vez.';
  end if;
  if char_length(trim(coalesce(change_note, ''))) > 300 then
    raise exception 'O motivo deve ter no maximo 300 caracteres.';
  end if;

  perform 1
  from public.households household
  where household.id = acting_profile.household_id
  for update;

  select settings.current_member_id
    into previous_member_id
  from public.stove_cleaning_rotation_settings settings
  where settings.household_id = acting_profile.household_id;

  if not found then
    raise exception 'Configure primeiro a ordem do rodizio do fogao.';
  end if;

  if not exists (
    select 1
    from public.stove_cleaning_rotation_members rotation
    join public.household_members member
      on member.household_id = rotation.household_id
     and member.id = rotation.member_id
     and member.active = true
    where rotation.household_id = acting_profile.household_id
      and rotation.member_id = target_member_id
  ) then
    raise exception 'A pessoa escolhida nao esta ativa na ordem do rodizio.';
  end if;

  if previous_member_id is not distinct from target_member_id then
    return;
  end if;

  select array_agg(rotation.member_id order by rotation.rotation_order)
    into ordered_ids
  from public.stove_cleaning_rotation_members rotation
  where rotation.household_id = acting_profile.household_id;

  update public.stove_cleaning_rotation_settings
  set current_member_id = target_member_id,
      current_since = now(),
      turn_number = turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where household_id = acting_profile.household_id;

  insert into public.stove_cleaning_rotation_changes (
    household_id,
    change_type,
    previous_current_member_id,
    current_member_id,
    previous_ordered_member_ids,
    ordered_member_ids,
    note,
    changed_by
  ) values (
    acting_profile.household_id,
    'current_member_changed',
    previous_member_id,
    target_member_id,
    coalesce(ordered_ids, array[]::uuid[]),
    coalesce(ordered_ids, array[]::uuid[]),
    nullif(trim(change_note), ''),
    acting_profile.id
  );
end;
$$;

revoke all on function public.set_stove_cleaning_current_member(uuid, text) from public;
grant execute on function public.set_stove_cleaning_current_member(uuid, text) to authenticated;

-- Remove a assinatura preliminar. Somente o morador esperado nao identifica
-- uma passagem especifica pelo ciclo: depois de uma volta completa, uma aba
-- antiga poderia encontrar a mesma pessoa novamente e avancar o turno errado.
drop function if exists public.confirm_stove_cleaning(uuid, text);

-- Qualquer usuario autenticado, ativo e vinculado a um morador ativo da casa
-- pode registrar a conclusao. A combinacao pessoa + numero do turno identifica
-- uma passagem especifica pelo rodizio. Uma repeticao de um turno ja concluido
-- retorna o registro existente, sem criar historico ou avancar novamente.
create or replace function public.confirm_stove_cleaning(
  expected_member_id uuid,
  expected_turn_number bigint,
  cleaning_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  current_member_id uuid;
  current_member_name text;
  current_turn_number bigint;
  following_member_id uuid;
  following_member_name text;
  normalized_note text;
  existing_history_id uuid;
  new_history_id uuid;
begin
  select profile.* into acting_profile
  from public.profiles profile
  join public.household_members member
    on member.household_id = profile.household_id
   and member.id = profile.member_id
   and member.active = true
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null then
    raise exception 'Seu usuario precisa estar vinculado a um morador ativo.';
  end if;
  if expected_member_id is null then
    raise exception 'Informe qual pessoa da vez esta sendo confirmada.';
  end if;
  if expected_turn_number is null or expected_turn_number <= 0 then
    raise exception 'Informe um numero de turno valido.';
  end if;
  if char_length(trim(coalesce(cleaning_note, ''))) > 300 then
    raise exception 'A observacao deve ter no maximo 300 caracteres.';
  end if;
  normalized_note := nullif(trim(cleaning_note), '');

  perform 1
  from public.households household
  where household.id = acting_profile.household_id
  for update;

  select
    settings.current_member_id,
    member.name,
    settings.turn_number
  into
    current_member_id,
    current_member_name,
    current_turn_number
  from public.stove_cleaning_rotation_settings settings
  join public.household_members member
    on member.household_id = settings.household_id
   and member.id = settings.current_member_id
   and member.active = true
  where settings.household_id = acting_profile.household_id;

  if current_member_id is null then
    raise exception 'Configure uma pessoa atual ativa no rodizio do fogao.';
  end if;

  if current_member_id is distinct from expected_member_id
    or current_turn_number is distinct from expected_turn_number then
    select history.id
      into existing_history_id
    from public.stove_cleaning_history history
    where history.household_id = acting_profile.household_id
      and history.turn_number = expected_turn_number
      and history.member_id = expected_member_id;

    if existing_history_id is not null then
      return existing_history_id;
    end if;

    raise exception 'O turno ou a pessoa da vez mudou. Atualize a pagina antes de confirmar a limpeza.';
  end if;

  following_member_id := public.next_stove_cleaning_member(
    acting_profile.household_id,
    current_member_id
  );
  if following_member_id is null
    or following_member_id = current_member_id then
    raise exception 'A ordem do rodizio precisa ter uma proxima pessoa ativa.';
  end if;

  select member.name into following_member_name
  from public.household_members member
  where member.household_id = acting_profile.household_id
    and member.id = following_member_id
    and member.active = true;

  insert into public.stove_cleaning_history (
    household_id,
    turn_number,
    member_id,
    member_name_snapshot,
    next_member_id,
    next_member_name_snapshot,
    confirmed_by,
    note
  ) values (
    acting_profile.household_id,
    current_turn_number,
    current_member_id,
    current_member_name,
    following_member_id,
    following_member_name,
    acting_profile.id,
    normalized_note
  )
  returning id into new_history_id;

  update public.stove_cleaning_rotation_settings
  set current_member_id = following_member_id,
      current_since = now(),
      turn_number = current_turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where household_id = acting_profile.household_id;

  return new_history_id;
end;
$$;

revoke all on function public.confirm_stove_cleaning(uuid, bigint, text) from public;
grant execute on function public.confirm_stove_cleaning(uuid, bigint, text) to authenticated;

-- Estado inicial da Casa Cinco: Vitor -> Patrick -> Belo -> William. Savio
-- nao participa deste rodizio. O seed nao sobrescreve configuracao existente.
do $$
declare
  target_household_id constant uuid := '11111111-1111-1111-1111-111111111111'::uuid;
  vitor_id constant uuid := '11111111-1111-1111-1111-111111111101'::uuid;
  patrick_id constant uuid := '11111111-1111-1111-1111-111111111104'::uuid;
  belo_id constant uuid := '11111111-1111-1111-1111-111111111102'::uuid;
  william_id constant uuid := '11111111-1111-1111-1111-111111111105'::uuid;
  seeded_order uuid[] := array[vitor_id, patrick_id, belo_id, william_id];
begin
  if not exists (
    select 1
    from public.households household
    where household.id = target_household_id
  ) then
    return;
  end if;

  if (
    select count(*)
    from public.household_members member
    where member.household_id = target_household_id
      and member.id = any(seeded_order)
      and member.active = true
  ) <> 4 then
    return;
  end if;

  if exists (
    select 1
    from public.stove_cleaning_rotation_settings settings
    where settings.household_id = target_household_id
  ) then
    return;
  end if;

  insert into public.stove_cleaning_rotation_settings (
    household_id,
    current_member_id,
    current_since,
    turn_number
  ) values (
    target_household_id,
    vitor_id,
    now(),
    1
  );

  insert into public.stove_cleaning_rotation_members (
    household_id,
    member_id,
    rotation_order
  )
  select target_household_id, seed.member_id, seed.position::integer
  from unnest(seeded_order) with ordinality as seed(member_id, position);

  insert into public.stove_cleaning_rotation_changes (
    household_id,
    change_type,
    current_member_id,
    ordered_member_ids,
    note
  ) values (
    target_household_id,
    'initialized',
    vitor_id,
    seeded_order,
    'Ordem inicial: Vitor, Patrick, Belo e William.'
  );
end;
$$;
