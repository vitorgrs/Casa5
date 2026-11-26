-- Moradores fora de casa, compras enviadas por moradores para aprovação e
-- notificações no app. Rode depois da 037_wallet_statement_reconciliation.sql.
--
-- Regras principais:
-- * Quem está fora de casa continua ativo e na ordem de todos os rodízios,
--   mas é pulado enquanto a ausência durar. Ao voltar, retoma a mesma posição.
-- * Uma compra enviada por um morador só vira compra de verdade quando alguém
--   com manage_shopping aprova; a aprovação usa a mesma função que já
--   registra compras (record_multi_item_shopping_purchase_v2).
-- * Notificações são geradas por triggers (cadastros que envolvem a pessoa e
--   mudanças de vez) e pelo cron da manhã (dia na escala e na lavanderia).

-- ============================================================
-- 0) Utilitários
-- ============================================================
create or replace function public.house_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

create or replace function public.current_member_id()
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select member_id from public.profiles
  where id = auth.uid() and status = 'active'
$$;

-- Formata valores no padrão brasileiro sem depender do lc_numeric do banco.
create or replace function public.format_brl(value numeric)
returns text
language sql
immutable
as $$
  select 'R$ ' || translate(to_char(coalesce(value, 0), 'FM999,999,990.00'), ',.', '.,')
$$;

revoke all on function public.current_member_id() from public;
grant execute on function public.current_member_id() to authenticated, service_role;
grant execute on function public.house_today() to authenticated, service_role;
grant execute on function public.format_brl(numeric) to authenticated, service_role;

-- ============================================================
-- 1) Ausências (morador fora de casa)
-- ============================================================
-- left_on é o primeiro dia fora; returned_on é o primeiro dia de volta
-- (intervalo semiaberto). returned_on nulo significa que ainda não voltou.
create table if not exists public.member_absences (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  left_on date not null,
  returned_on date,
  note text check (note is null or char_length(note) <= 300),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  ended_by uuid references auth.users(id) on delete set null,
  ended_at timestamptz,
  constraint member_absences_period_check
    check (returned_on is null or returned_on >= left_on),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

create unique index if not exists member_absences_one_open_idx
  on public.member_absences(member_id)
  where returned_on is null;
create index if not exists member_absences_household_idx
  on public.member_absences(household_id, left_on desc);

alter table public.member_absences enable row level security;

drop policy if exists member_absences_read on public.member_absences;
create policy member_absences_read on public.member_absences
for select to authenticated
using (household_id = public.current_household_id());

revoke all on table public.member_absences from anon, authenticated;
grant select on table public.member_absences to authenticated, service_role;

create or replace function public.member_is_away(
  target_member_id uuid,
  on_date date
)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.member_absences absence
    where absence.member_id = target_member_id
      and absence.left_on <= on_date
      and (absence.returned_on is null or absence.returned_on > on_date)
  )
$$;

revoke all on function public.member_is_away(uuid, date) from public;
grant execute on function public.member_is_away(uuid, date) to authenticated, service_role;

-- ============================================================
-- 2) Notificações
-- ============================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  kind text not null check (char_length(kind) between 1 and 60),
  title text not null check (char_length(title) between 1 and 160),
  body text check (body is null or char_length(body) <= 600),
  link text check (link is null or link like '/app%'),
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (member_id, dedupe_key),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

create index if not exists notifications_member_idx
  on public.notifications(member_id, created_at desc);
create index if not exists notifications_member_unread_idx
  on public.notifications(member_id)
  where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications
for select to authenticated
using (
  household_id = public.current_household_id()
  and member_id = public.current_member_id()
);

revoke all on table public.notifications from anon, authenticated;
grant select on table public.notifications to authenticated;
grant select, insert, update, delete on table public.notifications to service_role;

-- Controle do lembrete diário de rodízios (uma execução por casa e dia).
create table if not exists public.notification_sync_runs (
  household_id uuid not null references public.households(id) on delete cascade,
  run_date date not null,
  created_at timestamptz not null default now(),
  primary key (household_id, run_date)
);
alter table public.notification_sync_runs enable row level security;
revoke all on table public.notification_sync_runs from anon, authenticated;
grant select, insert, update, delete on table public.notification_sync_runs to service_role;

-- Cria uma notificação para um morador. Quem executou a ação não é avisado
-- sobre o próprio cadastro, exceto quando include_actor = true. A chave de
-- deduplicação impede avisos repetidos quando um cadastro é refeito.
create or replace function public.notify_member(
  target_household_id uuid,
  target_member_id uuid,
  notification_kind text,
  notification_title text,
  notification_body text default null,
  notification_link text default null,
  notification_dedupe_key text default null,
  include_actor boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_household_id is null or target_member_id is null then
    return;
  end if;
  if not include_actor
    and auth.uid() is not null
    and target_member_id is not distinct from public.current_member_id() then
    return;
  end if;

  insert into public.notifications (
    household_id, member_id, kind, title, body, link, dedupe_key
  )
  select
    target_household_id,
    target_member_id,
    notification_kind,
    left(notification_title, 160),
    left(notification_body, 600),
    notification_link,
    notification_dedupe_key
  where exists (
    select 1 from public.household_members member
    where member.id = target_member_id
      and member.household_id = target_household_id
      and member.active = true
  )
  on conflict (member_id, dedupe_key) do nothing;
end;
$$;

-- Avisa todos os moradores ativos que possuem a permissão (o administrador
-- sempre possui todas).
create or replace function public.notify_permission_holders(
  target_household_id uuid,
  required_permission text,
  notification_kind text,
  notification_title text,
  notification_body text default null,
  notification_link text default null,
  notification_dedupe_key text default null,
  skip_member_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  holder_member_id uuid;
begin
  for holder_member_id in
    select distinct profile.member_id
    from public.profiles profile
    where profile.household_id = target_household_id
      and profile.status = 'active'
      and profile.member_id is not null
      and (
        profile.role = 'admin'::public.user_role
        or (profile.permissions ->> required_permission) = 'true'
      )
  loop
    if holder_member_id is distinct from skip_member_id then
      perform public.notify_member(
        target_household_id,
        holder_member_id,
        notification_kind,
        notification_title,
        notification_body,
        notification_link,
        notification_dedupe_key
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.notify_member(uuid, uuid, text, text, text, text, text, boolean) from public;
revoke all on function public.notify_permission_holders(uuid, text, text, text, text, text, text, uuid) from public;
grant execute on function public.notify_member(uuid, uuid, text, text, text, text, text, boolean) to service_role;
grant execute on function public.notify_permission_holders(uuid, text, text, text, text, text, text, uuid) to service_role;

create or replace function public.mark_notifications_read(
  notification_ids uuid[] default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_member_id uuid := public.current_member_id();
  updated_count integer;
begin
  if acting_member_id is null then
    raise exception 'Sua conta ainda não está vinculada a um morador.';
  end if;

  update public.notifications
  set read_at = now()
  where member_id = acting_member_id
    and household_id = public.current_household_id()
    and read_at is null
    and (notification_ids is null or id = any(notification_ids));
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

revoke all on function public.mark_notifications_read(uuid[]) from public;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ============================================================
-- 3) Rodízios que pulam quem está fora
-- ============================================================

-- Escala diária: a vez anda um morador por dia, pulando quem está fora
-- naquele dia. Sem ausências o resultado é idêntico ao cálculo anterior
-- (deslocamento em dias módulo a quantidade de moradores).
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
  ordered_ids uuid[];
  member_count integer;
  absence_members uuid[];
  absence_starts date[];
  absence_ends date[];
  first_absence date;
  walk_start date;
  walk_day date;
  previous_index integer;
  candidate_index integer;
  found_index integer;
  step integer;
  absence_index integer;
  candidate_away boolean;
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

  select array_agg(rotation.member_id order by rotation.rotation_order)
    into ordered_ids
  from public.daily_rotation_members rotation
  join public.household_members member on member.id = rotation.member_id
  where rotation.household_id = target_household
    and member.active = true;

  member_count := coalesce(cardinality(ordered_ids), 0);
  if member_count = 0 then
    return null;
  end if;

  select
    array_agg(absence.member_id order by absence.left_on),
    array_agg(absence.left_on order by absence.left_on),
    array_agg(coalesce(absence.returned_on, 'infinity'::date) order by absence.left_on),
    min(greatest(absence.left_on, configured_start))
    into absence_members, absence_starts, absence_ends, first_absence
  from public.member_absences absence
  where absence.household_id = target_household
    and absence.member_id = any(ordered_ids)
    and absence.left_on <= assignment_date
    and (absence.returned_on is null or absence.returned_on > configured_start)
    and (absence.returned_on is null or absence.returned_on > absence.left_on);

  if first_absence is null then
    return ordered_ids[((assignment_date - configured_start) % member_count) + 1];
  end if;

  -- Até a primeira ausência vale o cálculo direto; dali em diante a vez
  -- anda dia a dia.
  walk_start := first_absence;
  if walk_start > configured_start then
    previous_index := ((walk_start - 1 - configured_start) % member_count) + 1;
  else
    previous_index := member_count;
  end if;

  walk_day := walk_start;
  while walk_day <= assignment_date loop
    found_index := null;
    for step in 1..member_count loop
      candidate_index := ((previous_index - 1 + step) % member_count) + 1;
      candidate_away := false;
      for absence_index in 1..cardinality(absence_members) loop
        if absence_members[absence_index] = ordered_ids[candidate_index]
          and absence_starts[absence_index] <= walk_day
          and absence_ends[absence_index] > walk_day then
          candidate_away := true;
          exit;
        end if;
      end loop;
      if not candidate_away then
        found_index := candidate_index;
        exit;
      end if;
    end loop;

    if walk_day = assignment_date then
      if found_index is null then
        return null;
      end if;
      return ordered_ids[found_index];
    end if;
    if found_index is not null then
      previous_index := found_index;
    end if;
    walk_day := walk_day + 1;
  end loop;

  return null;
end;
$$;

-- Galão: a próxima pessoa é a seguinte na ordem que não está fora hoje. Se
-- todos estiverem fora, mantém a regra antiga (seguinte na ordem).
create or replace function public.next_water_gallon_member(
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
    select rotation_order
    from public.water_gallon_rotation_members
    where household_id = target_household_id
      and member_id = after_member_id
  )
  select rotation.member_id
  from public.water_gallon_rotation_members rotation
  join public.household_members member
    on member.household_id = rotation.household_id
   and member.id = rotation.member_id
   and member.active = true
  cross join current_position
  where rotation.household_id = target_household_id
  order by
    case
      when rotation.member_id <> after_member_id
        and public.member_is_away(rotation.member_id, public.house_today()) then 1
      else 0
    end,
    case when rotation.rotation_order > current_position.rotation_order then 0 else 1 end,
    rotation.rotation_order
  limit 1;
$$;

-- Fogão (e lava-louça, que usa a mesma ordem): mesma regra do galão.
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
    case
      when rotation.member_id <> after_member_id
        and public.member_is_away(rotation.member_id, public.house_today()) then 1
      else 0
    end,
    case when rotation.rotation_order > current_position.rotation_order then 0 else 1 end,
    rotation.rotation_order
  limit 1;
$$;

-- Mapa da casa, modo equilibrado: quem está fora hoje não é sugerido.
create or replace function public.house_cleaning_balanced_team(
  target_area_id uuid,
  target_team_size integer
)
returns uuid[]
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(array_agg(ranked.member_id order by ranked.pick_order), array[]::uuid[])
  from (
    select
      rotation.member_id,
      row_number() over (
        order by
          count(history.id) asc,
          max(history.cleaned_at) asc nulls first,
          rotation.rotation_order,
          rotation.member_id
      ) as pick_order
    from public.house_cleaning_rotation_members rotation
    join public.household_members member
      on member.household_id = rotation.household_id
     and member.id = rotation.member_id
     and member.active = true
    left join public.house_cleaning_history history
      on history.area_id = rotation.area_id
     and rotation.member_id = any(history.member_ids_snapshot)
    where rotation.area_id = target_area_id
      and not public.member_is_away(rotation.member_id, public.house_today())
    group by rotation.member_id, rotation.rotation_order
  ) ranked
  where ranked.pick_order <= greatest(coalesce(target_team_size, 1), 1);
$$;

-- Mapa da casa, modo sequencial: a equipe começa na pessoa indicada (ou na
-- seguinte presente) e considera somente quem não está fora hoje.
create or replace function public.house_cleaning_round_robin_team(
  target_area_id uuid,
  target_start_member_id uuid,
  target_team_size integer,
  target_allow_incomplete boolean
)
returns uuid[]
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  ordered_member_ids uuid[];
  present_member_ids uuid[] := array[]::uuid[];
  member_count integer;
  present_count integer;
  start_index integer;
  present_until_end integer;
  resolved_team_size integer;
  result_member_ids uuid[];
  scan_offset integer;
  candidate_id uuid;
begin
  select coalesce(
    array_agg(member.id order by rotation.rotation_order),
    array[]::uuid[]
  )
    into ordered_member_ids
  from public.house_cleaning_rotation_members rotation
  join public.household_members member
    on member.household_id = rotation.household_id
   and member.id = rotation.member_id
   and member.active = true
  where rotation.area_id = target_area_id;

  member_count := cardinality(ordered_member_ids);
  if member_count = 0 then
    return array[]::uuid[];
  end if;

  start_index := coalesce(array_position(ordered_member_ids, target_start_member_id), 1);

  -- Percorre a ordem a partir da pessoa inicial e guarda somente quem está
  -- em casa, preservando a sequência.
  for scan_offset in 0..member_count - 1 loop
    candidate_id := ordered_member_ids[((start_index - 1 + scan_offset) % member_count) + 1];
    if not public.member_is_away(candidate_id, public.house_today()) then
      present_member_ids := present_member_ids || candidate_id;
    end if;
  end loop;

  present_count := cardinality(present_member_ids);
  if present_count = 0 then
    return array[]::uuid[];
  end if;

  resolved_team_size := least(greatest(coalesce(target_team_size, 1), 1), present_count);
  if coalesce(target_allow_incomplete, false) then
    -- No modo de grupos fixos a equipe não volta ao início da ordem: conta
    -- quantas pessoas presentes existem da primeira da equipe até o fim.
    select count(*)::integer
      into present_until_end
    from unnest(present_member_ids) as present(member_id)
    where array_position(ordered_member_ids, present.member_id) >=
      array_position(ordered_member_ids, present_member_ids[1]);
    resolved_team_size := least(resolved_team_size, greatest(present_until_end, 1));
  end if;

  result_member_ids := present_member_ids[1:resolved_team_size];
  return result_member_ids;
end;
$$;

-- Move a vez de quem está fora hoje para a próxima pessoa presente nos
-- rodízios por confirmação (galão, fogão, lava-louça) e recalcula as
-- sugestões do mapa da casa. É idempotente: o cron da manhã e o app chamam
-- esta função todos os dias para cobrir ausências agendadas.
create or replace function public.apply_member_absences(target_household_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := public.house_today();
  changes integer := 0;
  current_id uuid;
  next_id uuid;
  ordered_ids uuid[];
  away_name text;
  area_row public.house_cleaning_areas%rowtype;
  new_suggestion uuid[];
begin
  if target_household_id is null then
    return 0;
  end if;

  -- Galão de água
  select settings.current_member_id
    into current_id
  from public.water_gallon_rotation_settings settings
  where settings.household_id = target_household_id
  for update;
  if current_id is not null and public.member_is_away(current_id, today) then
    next_id := public.next_water_gallon_member(target_household_id, current_id);
    if next_id is not null and next_id <> current_id
      and not public.member_is_away(next_id, today) then
      select name into away_name from public.household_members where id = current_id;
      select array_agg(rotation.member_id order by rotation.rotation_order)
        into ordered_ids
      from public.water_gallon_rotation_members rotation
      where rotation.household_id = target_household_id;

      update public.water_gallon_rotation_settings
      set current_member_id = next_id,
          current_since = now(),
          updated_by = auth.uid(),
          updated_at = now()
      where household_id = target_household_id;

      insert into public.water_gallon_rotation_changes (
        household_id, change_type, previous_current_member_id, current_member_id,
        ordered_member_ids, note, changed_by
      ) values (
        target_household_id, 'current_member_changed', current_id, next_id,
        coalesce(ordered_ids, array[]::uuid[]),
        format('Vez passada automaticamente: %s está fora de casa.', away_name),
        auth.uid()
      );
      changes := changes + 1;
    end if;
  end if;

  -- Fogão
  select settings.current_member_id
    into current_id
  from public.stove_cleaning_rotation_settings settings
  where settings.household_id = target_household_id
  for update;
  if current_id is not null and public.member_is_away(current_id, today) then
    next_id := public.next_stove_cleaning_member(target_household_id, current_id);
    if next_id is not null and next_id <> current_id
      and not public.member_is_away(next_id, today) then
      select name into away_name from public.household_members where id = current_id;
      select array_agg(rotation.member_id order by rotation.rotation_order)
        into ordered_ids
      from public.stove_cleaning_rotation_members rotation
      where rotation.household_id = target_household_id;

      update public.stove_cleaning_rotation_settings
      set current_member_id = next_id,
          current_since = now(),
          turn_number = turn_number + 1,
          updated_by = auth.uid(),
          updated_at = now()
      where household_id = target_household_id;

      insert into public.stove_cleaning_rotation_changes (
        household_id, change_type, previous_current_member_id, current_member_id,
        previous_ordered_member_ids, ordered_member_ids, note, changed_by
      ) values (
        target_household_id, 'current_member_changed', current_id, next_id,
        coalesce(ordered_ids, array[]::uuid[]), coalesce(ordered_ids, array[]::uuid[]),
        format('Vez passada automaticamente: %s está fora de casa.', away_name),
        auth.uid()
      );
      changes := changes + 1;
    end if;
  end if;

  -- Lava e seca-louça (usa a ordem do fogão)
  select settings.current_member_id
    into current_id
  from public.dish_rack_cleaning_settings settings
  where settings.household_id = target_household_id
  for update;
  if current_id is not null and public.member_is_away(current_id, today) then
    next_id := public.next_stove_cleaning_member(target_household_id, current_id);
    if next_id is not null and next_id <> current_id
      and not public.member_is_away(next_id, today) then
      select name into away_name from public.household_members where id = current_id;

      update public.dish_rack_cleaning_settings
      set current_member_id = next_id,
          current_since = now(),
          turn_number = turn_number + 1,
          updated_by = auth.uid(),
          updated_at = now()
      where household_id = target_household_id;

      insert into public.dish_rack_cleaning_changes (
        household_id, change_type, previous_current_member_id, current_member_id,
        note, changed_by
      ) values (
        target_household_id, 'current_member_changed', current_id, next_id,
        format('Vez passada automaticamente: %s está fora de casa.', away_name),
        auth.uid()
      );
      changes := changes + 1;
    end if;
  end if;

  -- Mapa da casa: recalcula sugestões que incluem alguém fora de casa.
  for area_row in
    select *
    from public.house_cleaning_areas area
    where area.household_id = target_household_id
      and area.active = true
      and area.cleaning_mode in ('balanced', 'round_robin')
      and exists (
        select 1
        from unnest(area.suggested_member_ids) as suggested(member_id)
        where public.member_is_away(suggested.member_id, today)
      )
    for update
  loop
    if area_row.cleaning_mode = 'balanced' then
      new_suggestion := public.house_cleaning_balanced_team(area_row.id, area_row.max_cleaners);
    else
      new_suggestion := public.house_cleaning_round_robin_team(
        area_row.id,
        area_row.current_start_member_id,
        area_row.people_per_turn,
        area_row.allow_incomplete_last_group
      );
    end if;

    if cardinality(new_suggestion) > 0
      and new_suggestion is distinct from area_row.suggested_member_ids then
      update public.house_cleaning_areas
      set suggested_member_ids = new_suggestion,
          current_start_member_id = new_suggestion[1],
          updated_at = now()
      where id = area_row.id;
      changes := changes + 1;
    end if;
  end loop;

  return changes;
end;
$$;

revoke all on function public.apply_member_absences(uuid) from public;
grant execute on function public.apply_member_absences(uuid) to service_role;

-- ============================================================
-- 4) Marcar saída e volta
-- ============================================================
create or replace function public.mark_member_away(
  target_member_id uuid,
  away_from date,
  away_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  target_member public.household_members%rowtype;
  today date := public.house_today();
  new_absence_id uuid;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or not public.has_permission('manage_members') then
    raise exception 'Você não tem permissão para marcar a saída de moradores.';
  end if;
  if away_from is null then
    raise exception 'Informe a partir de quando o morador está fora.';
  end if;
  if away_from < today - 30 or away_from > today + 365 then
    raise exception 'A data de saída precisa estar entre os últimos 30 dias e o próximo ano.';
  end if;
  if char_length(trim(coalesce(away_note, ''))) > 300 then
    raise exception 'A observação deve ter no máximo 300 caracteres.';
  end if;

  perform 1 from public.households where id = acting_profile.household_id for update;

  select * into target_member
  from public.household_members
  where id = target_member_id
    and household_id = acting_profile.household_id
    and active = true;
  if target_member.id is null then
    raise exception 'Morador não encontrado ou inativo.';
  end if;

  if exists (
    select 1
    from public.member_absences absence
    where absence.member_id = target_member_id
      and absence.returned_on is distinct from absence.left_on
      and (absence.returned_on is null or absence.returned_on > away_from)
  ) then
    raise exception 'Já existe uma saída registrada para % que cobre essa data.', target_member.name;
  end if;

  insert into public.member_absences (
    household_id, member_id, left_on, note, created_by
  ) values (
    acting_profile.household_id,
    target_member_id,
    away_from,
    nullif(trim(away_note), ''),
    acting_profile.id
  )
  returning id into new_absence_id;

  -- Trocas pendentes de dias em que a pessoa estará fora deixam de fazer
  -- sentido; as aprovadas continuam valendo.
  update public.chore_day_swap_requests swap
  set status = 'rejected',
      reviewed_by = acting_profile.id,
      reviewed_at = now(),
      review_note = 'Cancelada automaticamente porque o morador está fora de casa.'
  where swap.household_id = acting_profile.household_id
    and swap.status = 'pending'
    and (
      (swap.requester_member_id = mark_member_away.target_member_id
        and swap.requester_date >= away_from)
      or (swap.target_member_id = mark_member_away.target_member_id
        and swap.target_date >= away_from)
    );

  if away_from <= today then
    perform public.apply_member_absences(acting_profile.household_id);
  end if;

  insert into public.system_events (household_id, event_type, title, detail, metadata)
  values (
    acting_profile.household_id,
    'member_away',
    format('%s saiu de casa', target_member.name),
    format('Fora a partir de %s.', to_char(away_from, 'DD/MM/YYYY')),
    jsonb_build_object('member_id', target_member_id, 'absence_id', new_absence_id, 'by', acting_profile.id)
  );

  return new_absence_id;
end;
$$;

create or replace function public.mark_member_returned(
  target_member_id uuid,
  returned_on_date date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  open_absence public.member_absences%rowtype;
  target_member public.household_members%rowtype;
  today date := public.house_today();
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or not public.has_permission('manage_members') then
    raise exception 'Você não tem permissão para registrar a volta de moradores.';
  end if;
  if returned_on_date is null then
    raise exception 'Informe a data de volta.';
  end if;

  perform 1 from public.households where id = acting_profile.household_id for update;

  select * into target_member
  from public.household_members
  where id = target_member_id
    and household_id = acting_profile.household_id;
  if target_member.id is null then
    raise exception 'Morador não encontrado.';
  end if;

  select * into open_absence
  from public.member_absences
  where member_id = target_member_id
    and household_id = acting_profile.household_id
    and returned_on is null
  for update;
  if open_absence.id is null then
    raise exception '% não está marcado como fora de casa.', target_member.name;
  end if;
  if returned_on_date < open_absence.left_on then
    raise exception 'A volta não pode ser antes da saída (%).', to_char(open_absence.left_on, 'DD/MM/YYYY');
  end if;
  if returned_on_date > today + 365 then
    raise exception 'A data de volta precisa estar dentro do próximo ano.';
  end if;

  update public.member_absences
  set returned_on = returned_on_date,
      ended_by = acting_profile.id,
      ended_at = now()
  where id = open_absence.id;

  insert into public.system_events (household_id, event_type, title, detail, metadata)
  values (
    acting_profile.household_id,
    'member_returned',
    case
      when returned_on_date = open_absence.left_on then format('Saída de %s cancelada', target_member.name)
      else format('%s voltou para casa', target_member.name)
    end,
    format('Volta em %s.', to_char(returned_on_date, 'DD/MM/YYYY')),
    jsonb_build_object('member_id', target_member_id, 'absence_id', open_absence.id, 'by', acting_profile.id)
  );

  return open_absence.id;
end;
$$;

revoke all on function public.mark_member_away(uuid, date, text) from public;
revoke all on function public.mark_member_returned(uuid, date) from public;
grant execute on function public.mark_member_away(uuid, date, text) to authenticated;
grant execute on function public.mark_member_returned(uuid, date) to authenticated;

-- ============================================================
-- 5) Compras enviadas por moradores para aprovação
-- ============================================================
create table if not exists public.shopping_purchase_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  requested_by_member_id uuid not null,
  requested_by uuid references auth.users(id) on delete set null,
  paid_by_member_id uuid not null,
  purchase_scope text not null check (purchase_scope in ('household', 'group', 'individual')),
  split_mode text not null check (split_mode in ('equal', 'custom')),
  participant_member_ids uuid[] not null default array[]::uuid[],
  custom_share_cents jsonb,
  -- [{source: 'list'|'extra', item_id?, name, quantity, unit_price}]
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  total_amount numeric(12,2) not null check (total_amount > 0),
  note text check (note is null or char_length(note) <= 300),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  purchase_id uuid references public.shopping_purchases(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 300),
  created_at timestamptz not null default now(),
  foreign key (household_id, requested_by_member_id)
    references public.household_members(household_id, id) on delete cascade,
  foreign key (household_id, paid_by_member_id)
    references public.household_members(household_id, id) on delete cascade
);

create index if not exists shopping_purchase_requests_household_idx
  on public.shopping_purchase_requests(household_id, status, created_at desc);
create index if not exists shopping_purchase_requests_member_idx
  on public.shopping_purchase_requests(requested_by_member_id, created_at desc);

alter table public.shopping_purchase_requests enable row level security;

drop policy if exists shopping_purchase_requests_read on public.shopping_purchase_requests;
create policy shopping_purchase_requests_read on public.shopping_purchase_requests
for select to authenticated
using (
  household_id = public.current_household_id()
  and (
    requested_by_member_id = public.current_member_id()
    or public.has_permission('manage_shopping')
  )
);

revoke all on table public.shopping_purchase_requests from anon, authenticated;
grant select on table public.shopping_purchase_requests to authenticated, service_role;

create or replace function public.submit_shopping_purchase_request(
  list_item_ids uuid[],
  list_quantities numeric[],
  list_unit_prices numeric[],
  extra_item_names text[],
  extra_quantities numeric[],
  extra_unit_prices numeric[],
  selected_scope text,
  participant_member_ids uuid[],
  selected_split_mode text,
  custom_share_cents jsonb,
  request_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  household_id_value uuid;
  normalized_list_ids uuid[] := coalesce(list_item_ids, array[]::uuid[]);
  normalized_extra_names text[] := coalesce(extra_item_names, array[]::text[]);
  normalized_participants uuid[];
  participant_count integer;
  item_count integer;
  total_cents bigint := 0;
  custom_total_cents bigint := 0;
  current_quantity numeric;
  current_price numeric;
  current_name text;
  current_member uuid;
  share_text text;
  item_position integer;
  items_json jsonb := '[]'::jsonb;
  new_request_id uuid;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or acting_profile.member_id is null then
    raise exception 'Sua conta precisa estar vinculada a um morador para enviar compras.';
  end if;
  household_id_value := acting_profile.household_id;

  if cardinality(normalized_list_ids) <> coalesce(cardinality(list_quantities), 0)
    or cardinality(normalized_list_ids) <> coalesce(cardinality(list_unit_prices), 0)
    or cardinality(normalized_extra_names) <> coalesce(cardinality(extra_quantities), 0)
    or cardinality(normalized_extra_names) <> coalesce(cardinality(extra_unit_prices), 0) then
    raise exception 'Os dados dos itens estão incompletos.';
  end if;

  item_count := cardinality(normalized_list_ids) + cardinality(normalized_extra_names);
  if item_count = 0 then
    raise exception 'Inclua pelo menos um item na compra.';
  end if;
  if item_count > 40 then
    raise exception 'Uma compra pode ter no máximo 40 itens.';
  end if;
  if (select count(distinct value) from unnest(normalized_list_ids) as ids(value))
    <> cardinality(normalized_list_ids) then
    raise exception 'Um item da lista foi selecionado mais de uma vez.';
  end if;
  if selected_scope is null or selected_scope not in ('household', 'group', 'individual') then
    raise exception 'Tipo de compra inválido.';
  end if;
  if selected_split_mode is null or selected_split_mode not in ('equal', 'custom') then
    raise exception 'Tipo de divisão inválido.';
  end if;
  if char_length(trim(coalesce(request_note, ''))) > 300 then
    raise exception 'A observação deve ter no máximo 300 caracteres.';
  end if;
  if (
    select count(*) from public.shopping_purchase_requests request
    where request.requested_by_member_id = acting_profile.member_id
      and request.status = 'pending'
  ) >= 15 then
    raise exception 'Você já tem muitas compras aguardando aprovação. Aguarde a revisão do administrador.';
  end if;

  -- Itens da lista
  for item_position in 1..cardinality(normalized_list_ids) loop
    select item.name into current_name
    from public.shopping_items item
    where item.id = normalized_list_ids[item_position]
      and item.household_id = household_id_value
      and item.status in ('list'::public.shopping_status, 'checked'::public.shopping_status);
    if current_name is null then
      raise exception 'Há um item inválido ou já comprado na seleção.';
    end if;
    current_quantity := round(list_quantities[item_position], 2);
    current_price := round(list_unit_prices[item_position], 2);
    if current_quantity is null or current_price is null
      or current_quantity <= 0 or current_price < 0 then
      raise exception 'Quantidade ou valor inválido em %.', current_name;
    end if;
    total_cents := total_cents + round(current_quantity * current_price * 100)::bigint;
    items_json := items_json || jsonb_build_array(jsonb_build_object(
      'source', 'list',
      'item_id', normalized_list_ids[item_position],
      'name', current_name,
      'quantity', current_quantity,
      'unit_price', current_price
    ));
  end loop;

  -- Itens que não estavam na lista
  for item_position in 1..cardinality(normalized_extra_names) loop
    current_name := trim(coalesce(normalized_extra_names[item_position], ''));
    if char_length(current_name) = 0 or char_length(current_name) > 120 then
      raise exception 'Informe o nome de cada item novo (até 120 caracteres).';
    end if;
    current_quantity := round(extra_quantities[item_position], 2);
    current_price := round(extra_unit_prices[item_position], 2);
    if current_quantity is null or current_price is null
      or current_quantity <= 0 or current_price < 0 then
      raise exception 'Quantidade ou valor inválido em %.', current_name;
    end if;
    total_cents := total_cents + round(current_quantity * current_price * 100)::bigint;
    items_json := items_json || jsonb_build_array(jsonb_build_object(
      'source', 'extra',
      'name', current_name,
      'quantity', current_quantity,
      'unit_price', current_price
    ));
  end loop;

  if total_cents <= 0 then
    raise exception 'O total da compra precisa ser maior que zero.';
  end if;

  if selected_scope = 'household' then
    select array_agg(id order by display_order, id)
      into normalized_participants
    from public.household_members
    where household_id = household_id_value and active = true;
  else
    select array_agg(distinct participant_id order by participant_id)
      into normalized_participants
    from unnest(coalesce(participant_member_ids, array[]::uuid[])) as participants(participant_id);
  end if;

  participant_count := coalesce(cardinality(normalized_participants), 0);
  if participant_count = 0 then
    raise exception 'Selecione quem participa da compra.';
  end if;
  if selected_scope = 'group' and participant_count < 2 then
    raise exception 'Uma compra de grupo precisa ter pelo menos duas pessoas.';
  end if;
  if selected_scope = 'individual' and participant_count <> 1 then
    raise exception 'Uma compra individual precisa ter exatamente uma pessoa.';
  end if;
  if (
    select count(*) from public.household_members
    where id = any(normalized_participants)
      and household_id = household_id_value
      and active = true
  ) <> participant_count then
    raise exception 'Há um participante inválido no rateio.';
  end if;

  if selected_split_mode = 'custom' then
    if custom_share_cents is null or jsonb_typeof(custom_share_cents) <> 'object'
      or (select count(*) from jsonb_object_keys(custom_share_cents)) <> participant_count then
      raise exception 'Informe exatamente um valor para cada participante.';
    end if;
    foreach current_member in array normalized_participants loop
      share_text := custom_share_cents ->> current_member::text;
      if share_text is null or share_text !~ '^[0-9]+$' then
        raise exception 'Há um valor personalizado inválido.';
      end if;
      custom_total_cents := custom_total_cents + share_text::bigint;
    end loop;
    if custom_total_cents <> total_cents then
      raise exception 'A divisão personalizada precisa somar %.', public.format_brl(total_cents / 100.0);
    end if;
  end if;

  insert into public.shopping_purchase_requests (
    household_id,
    requested_by_member_id,
    requested_by,
    paid_by_member_id,
    purchase_scope,
    split_mode,
    participant_member_ids,
    custom_share_cents,
    items,
    total_amount,
    note
  ) values (
    household_id_value,
    acting_profile.member_id,
    acting_profile.id,
    acting_profile.member_id,
    selected_scope,
    selected_split_mode,
    case when selected_scope = 'household' then array[]::uuid[] else normalized_participants end,
    case when selected_split_mode = 'custom' then custom_share_cents else null end,
    items_json,
    total_cents / 100.0,
    nullif(trim(request_note), '')
  )
  returning id into new_request_id;

  return new_request_id;
end;
$$;

create or replace function public.review_shopping_purchase_request(
  target_request_id uuid,
  approve boolean,
  decision_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  request_row public.shopping_purchase_requests%rowtype;
  item_entry jsonb;
  new_item_id uuid;
  purchase_item_ids uuid[] := array[]::uuid[];
  purchase_quantities numeric[] := array[]::numeric[];
  purchase_prices numeric[] := array[]::numeric[];
  requester_name text;
  new_purchase_id uuid;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para aprovar compras.';
  end if;
  if char_length(trim(coalesce(decision_note, ''))) > 300 then
    raise exception 'O motivo deve ter no máximo 300 caracteres.';
  end if;

  select * into request_row
  from public.shopping_purchase_requests
  where id = target_request_id
    and household_id = acting_profile.household_id
  for update;

  if request_row.id is null then
    raise exception 'Compra não encontrada.';
  end if;
  if request_row.status <> 'pending' then
    raise exception 'Esta compra já foi revisada.';
  end if;

  if not coalesce(approve, false) then
    update public.shopping_purchase_requests
    set status = 'rejected',
        reviewed_by = acting_profile.id,
        reviewed_at = now(),
        review_note = nullif(trim(decision_note), '')
    where id = request_row.id;
    return null;
  end if;

  select name into requester_name
  from public.household_members
  where id = request_row.requested_by_member_id;

  for item_entry in select value from jsonb_array_elements(request_row.items)
  loop
    if item_entry ->> 'source' = 'extra' then
      insert into public.shopping_items (
        household_id, name, note, quantity_planned, unit_price, added_by
      ) values (
        request_row.household_id,
        item_entry ->> 'name',
        format('Incluído na compra enviada por %s.', requester_name),
        (item_entry ->> 'quantity')::numeric,
        (item_entry ->> 'unit_price')::numeric,
        request_row.requested_by
      )
      returning id into new_item_id;
    else
      new_item_id := (item_entry ->> 'item_id')::uuid;
    end if;
    purchase_item_ids := purchase_item_ids || new_item_id;
    purchase_quantities := purchase_quantities || (item_entry ->> 'quantity')::numeric;
    purchase_prices := purchase_prices || (item_entry ->> 'unit_price')::numeric;
  end loop;

  -- A função existente valida itens, rateio e permissões e cria a compra,
  -- as parcelas e o vínculo com o galão dentro desta mesma transação.
  new_purchase_id := public.record_multi_item_shopping_purchase_v2(
    purchase_item_ids,
    purchase_quantities,
    purchase_prices,
    request_row.purchase_scope,
    request_row.paid_by_member_id,
    request_row.participant_member_ids,
    request_row.split_mode,
    request_row.custom_share_cents
  );

  update public.shopping_purchase_requests
  set status = 'approved',
      purchase_id = new_purchase_id,
      reviewed_by = acting_profile.id,
      reviewed_at = now(),
      review_note = nullif(trim(decision_note), '')
  where id = request_row.id;

  return new_purchase_id;
end;
$$;

create or replace function public.cancel_shopping_purchase_request(target_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_member_id uuid := public.current_member_id();
begin
  if acting_member_id is null then
    raise exception 'Sua conta ainda não está vinculada a um morador.';
  end if;

  update public.shopping_purchase_requests
  set status = 'cancelled',
      reviewed_at = now()
  where id = target_request_id
    and household_id = public.current_household_id()
    and requested_by_member_id = acting_member_id
    and status = 'pending';

  if not found then
    raise exception 'Compra não encontrada ou já revisada.';
  end if;
end;
$$;

revoke all on function public.submit_shopping_purchase_request(uuid[], numeric[], numeric[], text[], numeric[], numeric[], text, uuid[], text, jsonb, text) from public;
revoke all on function public.review_shopping_purchase_request(uuid, boolean, text) from public;
revoke all on function public.cancel_shopping_purchase_request(uuid) from public;
grant execute on function public.submit_shopping_purchase_request(uuid[], numeric[], numeric[], text[], numeric[], numeric[], text, uuid[], text, jsonb, text) to authenticated;
grant execute on function public.review_shopping_purchase_request(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_shopping_purchase_request(uuid) to authenticated;

-- ============================================================
-- 6) Triggers de notificação
-- ============================================================

-- Despesa cadastrada com parcela para o morador.
create or replace function public.notify_expense_share_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  expense_row public.expenses%rowtype;
  detail text;
begin
  select * into expense_row from public.expenses where id = new.expense_id;
  if expense_row.id is null or expense_row.status = 'cancelled' then
    return new;
  end if;

  detail := case
    when coalesce(new.amount, 0) > 0 then 'Sua parte: ' || public.format_brl(new.amount)
    else 'Valor ainda a definir'
  end;
  if expense_row.due_date is not null then
    detail := detail || ' • vence em ' || to_char(expense_row.due_date, 'DD/MM/YYYY');
  end if;

  perform public.notify_member(
    expense_row.household_id,
    new.member_id,
    'expense_created',
    'Nova despesa: ' || expense_row.title,
    detail,
    '/app/eu',
    'expense:' || expense_row.id::text
  );
  return new;
end;
$$;

drop trigger if exists expense_shares_notify on public.expense_shares;
create trigger expense_shares_notify
after insert on public.expense_shares
for each row execute function public.notify_expense_share_created();

-- Compra lançada com parte para o morador (exceto quem pagou).
create or replace function public.notify_purchase_share_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  purchase_row public.shopping_purchases%rowtype;
  payer_name text;
begin
  select * into purchase_row from public.shopping_purchases where id = new.purchase_id;
  if purchase_row.id is null or purchase_row.paid_by_member_id = new.member_id then
    return new;
  end if;
  select name into payer_name from public.household_members where id = purchase_row.paid_by_member_id;

  perform public.notify_member(
    purchase_row.household_id,
    new.member_id,
    'purchase_created',
    'Nova compra dividida com você',
    format('Sua parte: %s • pago por %s', public.format_brl(new.amount), split_part(coalesce(payer_name, 'outro morador'), ' ', 1)),
    '/app/eu',
    'purchase:' || purchase_row.id::text
  );
  return new;
end;
$$;

drop trigger if exists shopping_purchase_shares_notify on public.shopping_purchase_shares;
create trigger shopping_purchase_shares_notify
after insert on public.shopping_purchase_shares
for each row execute function public.notify_purchase_share_created();

-- Tarefa atribuída ao morador.
create or replace function public.notify_task_assigned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  task_row public.tasks%rowtype;
begin
  select * into task_row from public.tasks where id = new.task_id;
  if task_row.id is null then
    return new;
  end if;

  perform public.notify_member(
    task_row.household_id,
    new.member_id,
    'task_assigned',
    'Nova tarefa: ' || task_row.title,
    case when task_row.due_date is not null
      then 'Prazo: ' || to_char(task_row.due_date, 'DD/MM/YYYY')
      else null
    end,
    '/app/eu',
    'task:' || task_row.id::text
  );
  return new;
end;
$$;

drop trigger if exists task_assignees_notify on public.task_assignees;
create trigger task_assignees_notify
after insert on public.task_assignees
for each row execute function public.notify_task_assigned();

-- Compra enviada para aprovação e resultado da revisão.
create or replace function public.notify_purchase_request_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_name text;
begin
  select name into requester_name from public.household_members where id = new.requested_by_member_id;

  if tg_op = 'INSERT' then
    perform public.notify_permission_holders(
      new.household_id,
      'manage_shopping',
      'purchase_request_pending',
      'Compra aguardando aprovação',
      format('%s enviou uma compra de %s.', split_part(coalesce(requester_name, 'Um morador'), ' ', 1), public.format_brl(new.total_amount)),
      '/app/organizacao#aprovacoes',
      'purchase-request:' || new.id::text,
      new.requested_by_member_id
    );
  elsif new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    perform public.notify_member(
      new.household_id,
      new.requested_by_member_id,
      'purchase_request_' || new.status,
      case when new.status = 'approved'
        then 'Sua compra foi aprovada'
        else 'Sua compra não foi aprovada'
      end,
      case when new.status = 'approved'
        then format('A compra de %s já entrou nos acertos.', public.format_brl(new.total_amount))
        else coalesce('Motivo: ' || new.review_note, format('A compra de %s foi recusada.', public.format_brl(new.total_amount)))
      end,
      '/app/organizacao#minhas-compras',
      'purchase-request-' || new.status || ':' || new.id::text,
      true
    );
  end if;
  return new;
end;
$$;

drop trigger if exists shopping_purchase_requests_notify on public.shopping_purchase_requests;
create trigger shopping_purchase_requests_notify
after insert or update of status on public.shopping_purchase_requests
for each row execute function public.notify_purchase_request_change();

-- Pedidos de troca de dia na escala.
create or replace function public.notify_chore_swap_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_name text;
  target_name text;
begin
  select name into requester_name from public.household_members where id = new.requester_member_id;
  select name into target_name from public.household_members where id = new.target_member_id;

  if tg_op = 'INSERT' then
    perform public.notify_member(
      new.household_id,
      new.target_member_id,
      'swap_requested',
      'Pedido de troca de dia',
      format('%s quer trocar o dia %s pelo seu dia %s.',
        split_part(coalesce(requester_name, 'Um morador'), ' ', 1),
        to_char(new.requester_date, 'DD/MM'),
        to_char(new.target_date, 'DD/MM')),
      '/app/limpeza',
      'swap:' || new.id::text
    );
    perform public.notify_permission_holders(
      new.household_id,
      'manage_daily_rotation',
      'swap_pending',
      'Troca de dia aguardando aprovação',
      format('%s e %s: %s ↔ %s.',
        split_part(coalesce(requester_name, ''), ' ', 1),
        split_part(coalesce(target_name, ''), ' ', 1),
        to_char(new.requester_date, 'DD/MM'),
        to_char(new.target_date, 'DD/MM')),
      '/app/limpeza/rotina',
      'swap-pending:' || new.id::text,
      new.requester_member_id
    );
  elsif new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    perform public.notify_member(
      new.household_id,
      new.requester_member_id,
      'swap_' || new.status,
      case when new.status = 'approved' then 'Troca de dia aprovada' else 'Troca de dia recusada' end,
      format('%s ↔ %s com %s.%s',
        to_char(new.requester_date, 'DD/MM'),
        to_char(new.target_date, 'DD/MM'),
        split_part(coalesce(target_name, ''), ' ', 1),
        coalesce(' ' || new.review_note, '')),
      '/app/limpeza',
      'swap-' || new.status || ':' || new.id::text
    );
    if new.status = 'approved' then
      perform public.notify_member(
        new.household_id,
        new.target_member_id,
        'swap_approved',
        'Troca de dia aprovada',
        format('Seu dia passou de %s para %s.', to_char(new.target_date, 'DD/MM'), to_char(new.requester_date, 'DD/MM')),
        '/app/limpeza',
        'swap-approved:' || new.id::text
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists chore_day_swap_requests_notify on public.chore_day_swap_requests;
create trigger chore_day_swap_requests_notify
after insert or update of status on public.chore_day_swap_requests
for each row execute function public.notify_chore_swap_change();

-- Saída e volta de moradores.
create or replace function public.notify_member_absence_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  member_name text;
  other_member_id uuid;
begin
  select name into member_name from public.household_members where id = new.member_id;

  if tg_op = 'INSERT' then
    perform public.notify_member(
      new.household_id,
      new.member_id,
      'member_away',
      'Você está fora dos rodízios',
      format('A partir de %s você não entra nos rodízios. Ao voltar, retoma a mesma posição.', to_char(new.left_on, 'DD/MM/YYYY')),
      '/app/limpeza',
      'absence:' || new.id::text,
      true
    );
    for other_member_id in
      select id from public.household_members
      where household_id = new.household_id and active = true and id <> new.member_id
    loop
      perform public.notify_member(
        new.household_id,
        other_member_id,
        'member_away',
        format('%s está fora de casa', split_part(coalesce(member_name, 'Um morador'), ' ', 1)),
        format('A partir de %s os rodízios pulam essa pessoa. Confira seus próximos dias.', to_char(new.left_on, 'DD/MM/YYYY')),
        '/app/limpeza',
        'absence:' || new.id::text
      );
    end loop;
  elsif old.returned_on is null and new.returned_on is not null
    and new.returned_on > new.left_on then
    for other_member_id in
      select id from public.household_members
      where household_id = new.household_id and active = true
    loop
      perform public.notify_member(
        new.household_id,
        other_member_id,
        'member_returned',
        case when other_member_id = new.member_id
          then 'Bem-vindo de volta'
          else format('%s voltou para casa', split_part(coalesce(member_name, 'Um morador'), ' ', 1))
        end,
        case when other_member_id = new.member_id
          then format('A partir de %s você volta aos rodízios na mesma posição de antes.', to_char(new.returned_on, 'DD/MM/YYYY'))
          else format('A partir de %s essa pessoa volta aos rodízios na mesma posição de antes.', to_char(new.returned_on, 'DD/MM/YYYY'))
        end,
        '/app/limpeza',
        'absence-return:' || new.id::text,
        other_member_id = new.member_id
      );
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists member_absences_notify on public.member_absences;
create trigger member_absences_notify
after insert or update of returned_on on public.member_absences
for each row execute function public.notify_member_absence_change();

-- Mudança de vez nos rodízios por confirmação.
create or replace function public.notify_rotation_turn_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  notification_title text;
  notification_body text;
  notification_link text;
  turn_key text;
begin
  if new.current_member_id is null
    or new.current_member_id is not distinct from old.current_member_id then
    return new;
  end if;

  if tg_table_name = 'water_gallon_rotation_settings' then
    notification_title := 'Sua vez no galão de água';
    notification_body := 'Você é a pessoa da vez para comprar o próximo galão.';
    notification_link := '/app/limpeza/agua';
    turn_key := 'turn:water:' || extract(epoch from new.current_since)::bigint::text;
  elsif tg_table_name = 'stove_cleaning_rotation_settings' then
    notification_title := 'Sua vez de limpar o fogão';
    notification_body := 'Quando terminar, confirme a limpeza no app.';
    notification_link := '/app/limpeza/fogao';
    turn_key := 'turn:stove:' || (to_jsonb(new) ->> 'turn_number');
  else
    notification_title := 'Sua vez no lava e seca-louça';
    notification_body := 'Quando terminar, confirme a limpeza no app.';
    notification_link := '/app/limpeza/louca';
    turn_key := 'turn:dish:' || (to_jsonb(new) ->> 'turn_number');
  end if;

  perform public.notify_member(
    new.household_id,
    new.current_member_id,
    'rotation_turn',
    notification_title,
    notification_body,
    notification_link,
    turn_key,
    true
  );
  return new;
end;
$$;

drop trigger if exists water_gallon_turn_notify on public.water_gallon_rotation_settings;
create trigger water_gallon_turn_notify
after update of current_member_id on public.water_gallon_rotation_settings
for each row execute function public.notify_rotation_turn_change();

drop trigger if exists stove_cleaning_turn_notify on public.stove_cleaning_rotation_settings;
create trigger stove_cleaning_turn_notify
after update of current_member_id on public.stove_cleaning_rotation_settings
for each row execute function public.notify_rotation_turn_change();

drop trigger if exists dish_rack_turn_notify on public.dish_rack_cleaning_settings;
create trigger dish_rack_turn_notify
after update of current_member_id on public.dish_rack_cleaning_settings
for each row execute function public.notify_rotation_turn_change();

-- Mapa da casa: avisa quem passou a ser sugerido para limpar um cômodo. Uma
-- ausência pode mudar vários cômodos de uma vez; por isso existe um único
-- aviso por pessoa e dia, que acumula os nomes dos cômodos.
create or replace function public.notify_house_cleaning_suggestion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  suggested_id uuid;
begin
  if new.cleaning_mode not in ('balanced', 'round_robin') then
    return new;
  end if;

  foreach suggested_id in array coalesce(new.suggested_member_ids, array[]::uuid[]) loop
    if not (suggested_id = any(coalesce(old.suggested_member_ids, array[]::uuid[])))
      and exists (
        select 1 from public.household_members member
        where member.id = suggested_id
          and member.household_id = new.household_id
          and member.active = true
      ) then
      insert into public.notifications as existing (
        household_id, member_id, kind, title, body, link, dedupe_key
      ) values (
        new.household_id,
        suggested_id,
        'rotation_turn',
        'Sua vez no mapa da casa',
        new.name,
        '/app/limpeza/mapa',
        'turn:house:' || public.house_today()::text
      )
      on conflict (member_id, dedupe_key) do update
      set body = case
            when position(excluded.body in coalesce(existing.body, '')) > 0 then existing.body
            else left(coalesce(existing.body || ', ', '') || excluded.body, 600)
          end,
          read_at = null,
          created_at = now();
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists house_cleaning_suggestion_notify on public.house_cleaning_areas;
create trigger house_cleaning_suggestion_notify
after update of suggested_member_ids on public.house_cleaning_areas
for each row execute function public.notify_house_cleaning_suggestion();
