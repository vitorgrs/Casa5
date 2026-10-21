-- Rodizio manual de limpeza do lava-louca e do seca-louca. A ORDEM e a mesma
-- do rodizio do fogao (stove_cleaning_rotation_members): alterar a ordem no
-- fogao altera os dois. A pessoa da vez, o numero do turno e o historico sao
-- proprios deste rodizio, porque as limpezas acontecem em momentos diferentes.
-- Rode depois da 033_house_cleaning_rules.sql.

create table if not exists public.dish_rack_cleaning_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  current_member_id uuid references public.household_members(id) on delete set null,
  current_since timestamptz not null default now(),
  turn_number bigint not null default 1 check (turn_number > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Mesmo modelo do historico do fogao: turno unico por casa impede confirmacao
-- dupla, e os nomes sao snapshots para preservar o historico.
create table if not exists public.dish_rack_cleaning_history (
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

-- Auditoria das alteracoes da pessoa da vez (manuais ou por mudanca de ordem).
create table if not exists public.dish_rack_cleaning_changes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  change_type text not null check (
    change_type in ('initialized', 'current_member_changed', 'order_reconciled')
  ),
  previous_current_member_id uuid,
  current_member_id uuid,
  note text,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists dish_rack_cleaning_history_household_idx
  on public.dish_rack_cleaning_history(household_id, cleaned_at desc, created_at desc);
create index if not exists dish_rack_cleaning_changes_household_idx
  on public.dish_rack_cleaning_changes(household_id, changed_at desc);

alter table public.dish_rack_cleaning_settings enable row level security;
alter table public.dish_rack_cleaning_history enable row level security;
alter table public.dish_rack_cleaning_changes enable row level security;

drop policy if exists dish_rack_cleaning_settings_read
  on public.dish_rack_cleaning_settings;
create policy dish_rack_cleaning_settings_read
on public.dish_rack_cleaning_settings for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists dish_rack_cleaning_history_read
  on public.dish_rack_cleaning_history;
create policy dish_rack_cleaning_history_read
on public.dish_rack_cleaning_history for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists dish_rack_cleaning_changes_read
  on public.dish_rack_cleaning_changes;
create policy dish_rack_cleaning_changes_read
on public.dish_rack_cleaning_changes for select to authenticated
using (household_id = public.current_household_id());

-- Leitura direta; escritas somente pelas funcoes security definer abaixo.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.dish_rack_cleaning_settings from anon;
    revoke all on table public.dish_rack_cleaning_history from anon;
    revoke all on table public.dish_rack_cleaning_changes from anon;
  end if;
end;
$$;

revoke all on table public.dish_rack_cleaning_settings from authenticated;
revoke all on table public.dish_rack_cleaning_history from authenticated;
revoke all on table public.dish_rack_cleaning_changes from authenticated;
grant select on table public.dish_rack_cleaning_settings to authenticated;
grant select on table public.dish_rack_cleaning_history to authenticated;
grant select on table public.dish_rack_cleaning_changes to authenticated;

-- Mantem a pessoa da vez coerente com a ordem compartilhada. Se ela saiu da
-- ordem (ou ficou inativa), a vez passa para a primeira pessoa ativa da nova
-- ordem. Se ainda nao existe configuracao, ela e criada a partir da ordem.
create or replace function public.reconcile_dish_rack_cleaning(
  target_household_id uuid,
  acting_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  settings_exist boolean;
  previous_member_id uuid;
  first_member_id uuid;
begin
  select rotation.member_id
    into first_member_id
  from public.stove_cleaning_rotation_members rotation
  join public.household_members member
    on member.household_id = rotation.household_id
   and member.id = rotation.member_id
   and member.active = true
  where rotation.household_id = target_household_id
  order by rotation.rotation_order
  limit 1;

  select settings.current_member_id
    into previous_member_id
  from public.dish_rack_cleaning_settings settings
  where settings.household_id = target_household_id
  for update;
  settings_exist := found;

  if not settings_exist then
    if first_member_id is null then
      return;
    end if;

    insert into public.dish_rack_cleaning_settings (
      household_id,
      current_member_id,
      updated_by
    ) values (
      target_household_id,
      first_member_id,
      acting_user_id
    );

    insert into public.dish_rack_cleaning_changes (
      household_id,
      change_type,
      current_member_id,
      note,
      changed_by
    ) values (
      target_household_id,
      'initialized',
      first_member_id,
      'Rodizio iniciado com a mesma ordem do fogao.',
      acting_user_id
    );
    return;
  end if;

  if previous_member_id is not null and exists (
    select 1
    from public.stove_cleaning_rotation_members rotation
    join public.household_members member
      on member.household_id = rotation.household_id
     and member.id = rotation.member_id
     and member.active = true
    where rotation.household_id = target_household_id
      and rotation.member_id = previous_member_id
  ) then
    return;
  end if;

  if first_member_id is null
    or first_member_id is not distinct from previous_member_id then
    return;
  end if;

  update public.dish_rack_cleaning_settings
  set current_member_id = first_member_id,
      current_since = now(),
      turn_number = turn_number + 1,
      updated_by = acting_user_id,
      updated_at = now()
  where household_id = target_household_id;

  insert into public.dish_rack_cleaning_changes (
    household_id,
    change_type,
    previous_current_member_id,
    current_member_id,
    note,
    changed_by
  ) values (
    target_household_id,
    'order_reconciled',
    previous_member_id,
    first_member_id,
    'A pessoa da vez saiu da ordem do fogao.',
    acting_user_id
  );
end;
$$;

revoke all on function public.reconcile_dish_rack_cleaning(uuid, uuid) from public;

-- set_stove_cleaning_rotation sempre apaga e reinsere a ordem inteira. O
-- gatilho por instrucao roda depois do INSERT, quando a ordem ja esta final,
-- e reconcilia somente as casas afetadas.
create or replace function public.reconcile_dish_rack_after_stove_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_household_id uuid;
begin
  for affected_household_id in
    select distinct inserted.household_id from inserted
  loop
    perform public.reconcile_dish_rack_cleaning(affected_household_id, auth.uid());
  end loop;
  return null;
end;
$$;

revoke all on function public.reconcile_dish_rack_after_stove_order() from public;

drop trigger if exists stove_order_reconciles_dish_rack
  on public.stove_cleaning_rotation_members;
create trigger stove_order_reconciles_dish_rack
after insert on public.stove_cleaning_rotation_members
referencing new table as inserted
for each statement
execute function public.reconcile_dish_rack_after_stove_order();

create or replace function public.set_dish_rack_cleaning_current_member(
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

  -- Mesmo bloqueio usado pelo fogao: serializa ordem e confirmacoes da casa.
  perform 1
  from public.households household
  where household.id = acting_profile.household_id
  for update;

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
    raise exception 'A pessoa escolhida nao esta ativa na ordem do fogao.';
  end if;

  perform public.reconcile_dish_rack_cleaning(
    acting_profile.household_id,
    acting_profile.id
  );

  select settings.current_member_id
    into previous_member_id
  from public.dish_rack_cleaning_settings settings
  where settings.household_id = acting_profile.household_id;

  if previous_member_id is not distinct from target_member_id then
    return;
  end if;

  update public.dish_rack_cleaning_settings
  set current_member_id = target_member_id,
      current_since = now(),
      turn_number = turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where household_id = acting_profile.household_id;

  insert into public.dish_rack_cleaning_changes (
    household_id,
    change_type,
    previous_current_member_id,
    current_member_id,
    note,
    changed_by
  ) values (
    acting_profile.household_id,
    'current_member_changed',
    previous_member_id,
    target_member_id,
    nullif(trim(change_note), ''),
    acting_profile.id
  );
end;
$$;

revoke all on function public.set_dish_rack_cleaning_current_member(uuid, text) from public;
grant execute on function public.set_dish_rack_cleaning_current_member(uuid, text) to authenticated;

-- Qualquer morador ativo pode confirmar. Pessoa + numero do turno identificam
-- uma passagem especifica; repetir a confirmacao de um turno ja concluido
-- devolve o registro existente sem avancar de novo.
create or replace function public.confirm_dish_rack_cleaning(
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
  from public.dish_rack_cleaning_settings settings
  join public.household_members member
    on member.household_id = settings.household_id
   and member.id = settings.current_member_id
   and member.active = true
  where settings.household_id = acting_profile.household_id;

  if current_member_id is null then
    raise exception 'Configure uma pessoa atual ativa no rodizio do lava-louca.';
  end if;

  if current_member_id is distinct from expected_member_id
    or current_turn_number is distinct from expected_turn_number then
    select history.id
      into existing_history_id
    from public.dish_rack_cleaning_history history
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
    raise exception 'A ordem do fogao precisa ter uma proxima pessoa ativa.';
  end if;

  select member.name into following_member_name
  from public.household_members member
  where member.household_id = acting_profile.household_id
    and member.id = following_member_id
    and member.active = true;

  insert into public.dish_rack_cleaning_history (
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

  update public.dish_rack_cleaning_settings
  set current_member_id = following_member_id,
      current_since = now(),
      turn_number = current_turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where household_id = acting_profile.household_id;

  return new_history_id;
end;
$$;

revoke all on function public.confirm_dish_rack_cleaning(uuid, bigint, text) from public;
grant execute on function public.confirm_dish_rack_cleaning(uuid, bigint, text) to authenticated;

-- Estado inicial: toda casa que ja tem a ordem do fogao comeca pela primeira
-- pessoa dessa ordem. Configuracoes existentes nao sao alteradas.
do $$
declare
  configured_household_id uuid;
begin
  for configured_household_id in
    select distinct rotation.household_id
    from public.stove_cleaning_rotation_members rotation
  loop
    perform public.reconcile_dish_rack_cleaning(configured_household_id, null);
  end loop;
end;
$$;
