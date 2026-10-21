-- Controle de acesso granular: o administrador define, por morador, quais
-- funcionalidades pode usar e quais paginas pode ver. Antes, quase toda a
-- administracao exigia role = 'admin' diretamente nas funcoes e politicas.
-- Rode depois da 035_storage_usage_monitoring.sql.
--
-- Chaves de permissao (devem coincidir com src/lib/permissions.ts):
--   manage_expenses, delete_expenses, mark_expenses_paid,
--   record_payments_without_receipt, view_wallet_balance, manage_wallet,
--   manage_shopping, manage_shopping_settlements, manage_tasks,
--   manage_daily_rotation, manage_laundry, manage_water, manage_stove_dish,
--   manage_house_map, manage_members, manage_notifications, manage_storage
-- O administrador sempre tem todas. Editar permissoes nunca e delegavel.

-- ============================================================
-- 1) Paginas ocultas por perfil
-- ============================================================
alter table public.profiles
  add column if not exists hidden_pages text[] not null default array[]::text[];

create or replace function public.valid_permission_keys()
returns text[]
language sql
immutable
as $$
  select array[
    'manage_expenses', 'delete_expenses', 'mark_expenses_paid',
    'record_payments_without_receipt', 'view_wallet_balance', 'manage_wallet',
    'manage_shopping', 'manage_shopping_settlements', 'manage_tasks',
    'manage_daily_rotation', 'manage_laundry', 'manage_water',
    'manage_stove_dish', 'manage_house_map', 'manage_members',
    'manage_notifications', 'manage_storage'
  ]::text[]
$$;

create or replace function public.valid_page_keys()
returns text[]
language sql
immutable
as $$
  select array[
    'overview', 'me', 'expenses', 'chores', 'daily_rotation_admin', 'laundry',
    'water', 'stove', 'dish_rack', 'house_map', 'shopping', 'finance',
    'complaints', 'members', 'settings'
  ]::text[]
$$;

-- ============================================================
-- 2) has_permission
-- ============================================================
-- Agora exige perfil ativo e deixa de tratar manage_shopping como exclusiva
-- do administrador (regra da 008): ela volta a ser delegavel. Compara com
-- 'true' para que um valor invalido no JSON nao derrube a consulta.
create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (
      select p.role = 'admin'::public.user_role
        or (p.permissions ->> perm) = 'true'
      from public.profiles p
      where p.id = auth.uid()
        and p.status = 'active'
        and p.household_id = public.current_household_id()
    ),
    false
  )
$$;

-- ============================================================
-- 3) Salvar o acesso de um morador
-- ============================================================
-- Unica forma de alterar permissoes e paginas. Valida as chaves, impede
-- editar administradores e grava auditoria em system_events.
create or replace function public.set_profile_access(
  target_profile_id uuid,
  granted_permissions text[],
  hidden_page_keys text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  target_profile public.profiles%rowtype;
  invalid_key text;
  normalized_permissions jsonb;
  normalized_pages text[];
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode alterar permissoes.';
  end if;

  select * into target_profile
  from public.profiles
  where id = target_profile_id
    and household_id = acting_profile.household_id;

  if target_profile.id is null then
    raise exception 'Morador nao encontrado.';
  end if;
  if target_profile.role = 'admin'::public.user_role then
    raise exception 'O administrador sempre tem acesso total.';
  end if;

  select key into invalid_key
  from unnest(coalesce(granted_permissions, array[]::text[])) as provided(key)
  where not (key = any(public.valid_permission_keys()))
  limit 1;
  if invalid_key is not null then
    raise exception 'Permissao desconhecida: %', invalid_key;
  end if;

  select key into invalid_key
  from unnest(coalesce(hidden_page_keys, array[]::text[])) as provided(key)
  where not (key = any(public.valid_page_keys()))
  limit 1;
  if invalid_key is not null then
    raise exception 'Pagina desconhecida: %', invalid_key;
  end if;

  -- Grava todas as chaves conhecidas (true/false) para o JSON ficar explicito.
  select jsonb_object_agg(
    key,
    key = any(coalesce(granted_permissions, array[]::text[]))
  )
  into normalized_permissions
  from unnest(public.valid_permission_keys()) as catalog(key);

  select coalesce(array_agg(distinct key order by key), array[]::text[])
  into normalized_pages
  from unnest(coalesce(hidden_page_keys, array[]::text[])) as provided(key);

  update public.profiles
  set permissions = normalized_permissions,
      hidden_pages = normalized_pages
  where id = target_profile.id;

  insert into public.system_events (
    household_id,
    event_type,
    title,
    detail,
    metadata
  ) values (
    acting_profile.household_id,
    'profile_access_updated',
    'Permissoes atualizadas',
    target_profile.full_name,
    jsonb_build_object(
      'profile_id', target_profile.id,
      'changed_by', acting_profile.id,
      'previous_permissions', coalesce(target_profile.permissions, '{}'::jsonb),
      'previous_hidden_pages', to_jsonb(coalesce(target_profile.hidden_pages, array[]::text[])),
      'permissions', normalized_permissions,
      'hidden_pages', to_jsonb(normalized_pages)
    )
  );
end;
$$;

revoke all on function public.set_profile_access(uuid, text[], text[]) from public;
grant execute on function public.set_profile_access(uuid, text[], text[]) to authenticated;

-- Moradores sem papel de administrador nunca podem gravar nas colunas de
-- acesso diretamente, mesmo que uma politica futura libere UPDATE em profiles.
create or replace function public.protect_profile_access_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.permissions is distinct from old.permissions
      or new.hidden_pages is distinct from old.hidden_pages
      or new.role is distinct from old.role)
    and auth.uid() is not null
    and not exists (
      select 1 from public.profiles
      where id = auth.uid()
        and status = 'active'
        and role = 'admin'::public.user_role
    ) then
    raise exception 'Somente o administrador pode alterar permissoes.';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_access_columns on public.profiles;
create trigger profiles_protect_access_columns
before update on public.profiles
for each row execute function public.protect_profile_access_columns();

-- ============================================================
-- 4) Politicas RLS para as permissoes delegaveis
-- ============================================================
-- As politicas *_admin_all continuam valendo; estas apenas somam o acesso
-- de quem recebeu a permissao correspondente.

drop policy if exists expenses_permission_delete on public.expenses;
create policy expenses_permission_delete on public.expenses
for delete to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('delete_expenses'));

drop policy if exists wallet_permission_manage on public.wallet_snapshots;
create policy wallet_permission_manage on public.wallet_snapshots
for insert to authenticated
with check (household_id = public.current_household_id()
  and public.has_permission('manage_wallet'));

drop policy if exists shopping_items_permission_manage on public.shopping_items;
create policy shopping_items_permission_manage on public.shopping_items
for all to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_shopping'))
with check (household_id = public.current_household_id()
  and public.has_permission('manage_shopping'));

drop policy if exists shopping_purchases_permission_manage on public.shopping_purchases;
create policy shopping_purchases_permission_manage on public.shopping_purchases
for all to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_shopping'))
with check (household_id = public.current_household_id()
  and public.has_permission('manage_shopping'));

drop policy if exists shopping_purchase_shares_permission_manage on public.shopping_purchase_shares;
create policy shopping_purchase_shares_permission_manage on public.shopping_purchase_shares
for all to authenticated
using (exists (
  select 1 from public.shopping_purchases purchase
  where purchase.id = purchase_id
    and purchase.household_id = public.current_household_id()
    and public.has_permission('manage_shopping')
))
with check (exists (
  select 1 from public.shopping_purchases purchase
  where purchase.id = purchase_id
    and purchase.household_id = public.current_household_id()
    and public.has_permission('manage_shopping')
));

drop policy if exists daily_standard_tasks_permission_manage on public.daily_standard_tasks;
create policy daily_standard_tasks_permission_manage on public.daily_standard_tasks
for all to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_daily_rotation'))
with check (household_id = public.current_household_id()
  and public.has_permission('manage_daily_rotation'));

drop policy if exists laundry_collective_washes_permission_manage on public.laundry_collective_washes;
create policy laundry_collective_washes_permission_manage on public.laundry_collective_washes
for all to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_laundry'))
with check (household_id = public.current_household_id()
  and public.has_permission('manage_laundry'));

drop policy if exists laundry_rotation_overrides_permission_manage on public.laundry_rotation_overrides;
create policy laundry_rotation_overrides_permission_manage on public.laundry_rotation_overrides
for all to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_laundry'))
with check (household_id = public.current_household_id()
  and public.has_permission('manage_laundry'));

drop policy if exists household_settings_permission_manage on public.household_settings;
create policy household_settings_permission_manage on public.household_settings
for all to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_notifications'))
with check (household_id = public.current_household_id()
  and public.has_permission('manage_notifications'));

-- O acerto de compras e lido por devedor, credor e administrador. Quem
-- gerencia acertos tambem precisa enxergar os pagamentos dos outros.
drop policy if exists shopping_settlement_payments_permission_read on public.shopping_settlement_payments;
create policy shopping_settlement_payments_permission_read on public.shopping_settlement_payments
for select to authenticated
using (household_id = public.current_household_id()
  and public.has_permission('manage_shopping_settlements'));

-- ============================================================
-- 5) Funcoes que exigiam administrador
-- ============================================================
-- Geradas a partir das definicoes atuais (pg_get_functiondef): a unica
-- mudanca em cada uma e a checagem de administrador trocada pela permissao
-- indicada e a mensagem "Somente o administrador pode" trocada por
-- "Voce nao tem permissao para". CREATE OR REPLACE preserva os GRANTs.

-- initialize_house_cleaning_map: exige a permissao manage_house_map.
CREATE OR REPLACE FUNCTION public.initialize_house_cleaning_map()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
begin
  select profile.* into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_house_map') then
    raise exception 'Voce nao tem permissao para inicializar o mapa de limpeza.';
  end if;

  perform public.initialize_house_cleaning_map_for_household(
    acting_profile.household_id,
    acting_profile.id
  );
end;
$function$;

-- set_house_cleaning_current_member: exige a permissao manage_house_map.
CREATE OR REPLACE FUNCTION public.set_house_cleaning_current_member(target_area_slug text, target_member_id uuid, change_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  target_area public.house_cleaning_areas%rowtype;
  normalized_slug text;
  normalized_note text;
  target_rotation_order integer;
  resolved_suggestion uuid[];
begin
  select profile.* into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_house_map') then
    raise exception 'Voce nao tem permissao para alterar a pessoa inicial da vez.';
  end if;

  normalized_slug := lower(trim(coalesce(target_area_slug, '')));
  if normalized_slug = '' then
    raise exception 'Informe o comodo que sera alterado.';
  end if;
  if target_member_id is null then
    raise exception 'Selecione a pessoa que inicia a equipe atual.';
  end if;
  if char_length(trim(coalesce(change_note, ''))) > 300 then
    raise exception 'O motivo deve ter no maximo 300 caracteres.';
  end if;
  normalized_note := nullif(trim(change_note), '');

  perform 1
  from public.households household
  where household.id = acting_profile.household_id
  for update;

  select area.* into target_area
  from public.house_cleaning_areas area
  where area.household_id = acting_profile.household_id
    and area.slug = normalized_slug
    and area.active = true;

  if target_area.id is null then
    raise exception 'Comodo ativo nao encontrado. Inicialize o mapa de limpeza primeiro.';
  end if;
  if target_area.cleaning_mode <> 'round_robin' then
    raise exception 'Este comodo nao possui uma pessoa inicial configuravel.';
  end if;

  select rotation.rotation_order
    into target_rotation_order
  from public.house_cleaning_rotation_members rotation
  join public.household_members member
    on member.household_id = rotation.household_id
   and member.id = rotation.member_id
   and member.active = true
  where rotation.area_id = target_area.id
    and rotation.member_id = target_member_id;

  if target_rotation_order is null then
    raise exception 'A pessoa escolhida nao esta ativa na ordem deste comodo.';
  end if;
  if target_area.allow_incomplete_last_group
    and ((target_rotation_order - 1) % target_area.people_per_turn) <> 0 then
    raise exception 'Escolha a primeira pessoa de uma equipe configurada para este comodo.';
  end if;

  resolved_suggestion := public.house_cleaning_round_robin_team(
    target_area.id,
    target_member_id,
    target_area.people_per_turn,
    target_area.allow_incomplete_last_group
  );

  if target_area.current_start_member_id is not distinct from target_member_id
    and target_area.suggested_member_ids = resolved_suggestion then
    return;
  end if;

  update public.house_cleaning_areas
  set current_start_member_id = target_member_id,
      suggested_member_ids = resolved_suggestion,
      current_since = now(),
      turn_number = turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where id = target_area.id;

  insert into public.system_events (
    household_id,
    event_type,
    title,
    detail,
    metadata
  ) values (
    acting_profile.household_id,
    'house_cleaning_current_member_changed',
    'Pessoa inicial da limpeza alterada',
    normalized_note,
    jsonb_build_object(
      'areaId', target_area.id,
      'areaSlug', target_area.slug,
      'previousMemberId', target_area.current_start_member_id,
      'currentMemberId', target_member_id
    )
  );
end;
$function$;

-- set_house_cleaning_rotation: exige a permissao manage_house_map.
CREATE OR REPLACE FUNCTION public.set_house_cleaning_rotation(target_area_slug text, ordered_member_ids uuid[], target_people_per_turn integer, target_allow_incomplete_last_group boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  target_area public.house_cleaning_areas%rowtype;
  normalized_slug text;
  provided_member_count integer;
  distinct_member_count integer;
  previous_ordered_member_ids uuid[];
  resolved_current_member_id uuid;
  resolved_suggestion uuid[];
begin
  select profile.* into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_house_map') then
    raise exception 'Voce nao tem permissao para configurar o rodizio dos comodos.';
  end if;

  normalized_slug := lower(trim(coalesce(target_area_slug, '')));
  if normalized_slug = '' then
    raise exception 'Informe o comodo que sera configurado.';
  end if;
  if target_people_per_turn is null or target_people_per_turn not between 1 and 2 then
    raise exception 'A equipe deve ter uma ou duas pessoas.';
  end if;
  if target_allow_incomplete_last_group is null then
    raise exception 'Informe se a ultima equipe pode ficar incompleta.';
  end if;

  select count(*)::integer, count(distinct provided.member_id)::integer
    into provided_member_count, distinct_member_count
  from unnest(coalesce(ordered_member_ids, array[]::uuid[]))
    as provided(member_id);

  if provided_member_count = 0 then
    raise exception 'O rodizio precisa ter pelo menos uma pessoa.';
  end if;
  if distinct_member_count <> provided_member_count
    or exists (
      select 1
      from unnest(ordered_member_ids) as provided(member_id)
      where provided.member_id is null
    ) then
    raise exception 'Cada pessoa pode aparecer apenas uma vez na ordem.';
  end if;
  if target_people_per_turn > provided_member_count then
    raise exception 'A equipe nao pode ser maior que a quantidade de pessoas na ordem.';
  end if;

  perform 1
  from public.households household
  where household.id = acting_profile.household_id
  for update;

  select area.* into target_area
  from public.house_cleaning_areas area
  where area.household_id = acting_profile.household_id
    and area.slug = normalized_slug
    and area.active = true;

  if target_area.id is null then
    raise exception 'Comodo ativo nao encontrado. Inicialize o mapa de limpeza primeiro.';
  end if;
  if target_area.cleaning_mode <> 'round_robin' then
    raise exception 'A regra deste comodo e definida pelo mapa e nao usa ordem sequencial.';
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

  select coalesce(
    array_agg(rotation.member_id order by rotation.rotation_order),
    array[]::uuid[]
  )
    into previous_ordered_member_ids
  from public.house_cleaning_rotation_members rotation
  where rotation.area_id = target_area.id;

  resolved_current_member_id := case
    when target_area.current_start_member_id = any(ordered_member_ids)
      and (
        not target_allow_incomplete_last_group
        or (
          (array_position(ordered_member_ids, target_area.current_start_member_id) - 1)
          % target_people_per_turn
        ) = 0
      )
      then target_area.current_start_member_id
    else ordered_member_ids[1]
  end;

  if previous_ordered_member_ids = ordered_member_ids
    and target_area.current_start_member_id is not distinct from resolved_current_member_id
    and target_area.people_per_turn = target_people_per_turn
    and target_area.min_cleaners = (
      case
        when target_allow_incomplete_last_group then 1
        else target_people_per_turn
      end
    )
    and target_area.max_cleaners = target_people_per_turn
    and target_area.allow_incomplete_last_group = target_allow_incomplete_last_group then
    resolved_suggestion := public.house_cleaning_round_robin_team(
      target_area.id,
      resolved_current_member_id,
      target_people_per_turn,
      target_allow_incomplete_last_group
    );
    if target_area.suggested_member_ids = resolved_suggestion then
      return;
    end if;
  end if;

  delete from public.house_cleaning_rotation_members
  where area_id = target_area.id;

  insert into public.house_cleaning_rotation_members (
    area_id,
    household_id,
    member_id,
    rotation_order
  )
  select
    target_area.id,
    acting_profile.household_id,
    provided.member_id,
    provided.position::integer
  from unnest(ordered_member_ids) with ordinality
    as provided(member_id, position);

  resolved_suggestion := public.house_cleaning_round_robin_team(
    target_area.id,
    resolved_current_member_id,
    target_people_per_turn,
    target_allow_incomplete_last_group
  );

  update public.house_cleaning_areas
  set people_per_turn = target_people_per_turn,
      min_cleaners = case
        when target_allow_incomplete_last_group then 1
        else target_people_per_turn
      end,
      max_cleaners = target_people_per_turn,
      allow_incomplete_last_group = target_allow_incomplete_last_group,
      current_start_member_id = resolved_current_member_id,
      suggested_member_ids = resolved_suggestion,
      current_since = now(),
      turn_number = turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where id = target_area.id;
end;
$function$;

-- register_house_cleaning: exige a permissao manage_house_map.
CREATE OR REPLACE FUNCTION public.register_house_cleaning(target_area_slug text, expected_turn_number bigint, cleaner_member_ids uuid[], cleaning_date date DEFAULT NULL::date, cleaning_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  target_area public.house_cleaning_areas%rowtype;
  normalized_slug text;
  normalized_note text;
  resolved_cleaning_date date;
  today_in_sao_paulo date;
  provided_count integer;
  provided_distinct_count integer;
  eligible_member_count integer;
  resolved_member_ids uuid[];
  resolved_member_names text[];
  current_suggestion uuid[];
  next_member_ids uuid[] := array[]::uuid[];
  next_member_names text[] := array[]::text[];
  active_ordered_member_ids uuid[];
  current_start_index integer;
  next_start_index integer;
  next_start_member_id uuid;
  existing_history_id uuid;
  existing_member_ids uuid[];
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

  normalized_slug := lower(trim(coalesce(target_area_slug, '')));
  if normalized_slug = '' then
    raise exception 'Informe o comodo que foi limpo.';
  end if;
  if expected_turn_number is null or expected_turn_number <= 0 then
    raise exception 'Informe um numero de turno valido.';
  end if;

  select count(*)::integer, count(distinct provided.member_id)::integer
    into provided_count, provided_distinct_count
  from unnest(coalesce(cleaner_member_ids, array[]::uuid[]))
    as provided(member_id);

  if provided_count = 0 or provided_count > 2 then
    raise exception 'Selecione uma ou duas pessoas que limparam.';
  end if;
  if provided_distinct_count <> provided_count
    or exists (
      select 1
      from unnest(cleaner_member_ids) as provided(member_id)
      where provided.member_id is null
    ) then
    raise exception 'A equipe informada contem pessoas invalidas ou repetidas.';
  end if;
  if char_length(trim(coalesce(cleaning_note, ''))) > 300 then
    raise exception 'A observacao deve ter no maximo 300 caracteres.';
  end if;

  normalized_note := nullif(trim(cleaning_note), '');
  today_in_sao_paulo := (now() at time zone 'America/Sao_Paulo')::date;
  resolved_cleaning_date := coalesce(cleaning_date, today_in_sao_paulo);
  if resolved_cleaning_date > today_in_sao_paulo then
    raise exception 'A data da limpeza nao pode estar no futuro.';
  end if;

  perform 1
  from public.households household
  where household.id = acting_profile.household_id
  for update;

  select area.* into target_area
  from public.house_cleaning_areas area
  where area.household_id = acting_profile.household_id
    and area.slug = normalized_slug
    and area.active = true;

  if target_area.id is null then
    raise exception 'Comodo ativo nao encontrado. Inicialize o mapa de limpeza primeiro.';
  end if;

  -- A repeticao de uma requisicao cuja resposta se perdeu devolve o mesmo ID,
  -- desde que contenha exatamente o mesmo conjunto de moradores.
  select history.id, history.member_ids_snapshot
    into existing_history_id, existing_member_ids
  from public.house_cleaning_history history
  where history.area_id = target_area.id
    and history.turn_number = expected_turn_number;

  if existing_history_id is not null then
    if cardinality(existing_member_ids) = provided_count
      and not exists (
        select 1
        from unnest(existing_member_ids) as existing(member_id)
        where not (existing.member_id = any(cleaner_member_ids))
      ) then
      return existing_history_id;
    end if;
    raise exception 'O turno informado ja foi registrado por outra equipe.';
  end if;

  if target_area.turn_number is distinct from expected_turn_number then
    raise exception 'O turno mudou. Atualize a pagina antes de registrar a limpeza.';
  end if;

  if provided_count < target_area.min_cleaners
    or provided_count > target_area.max_cleaners then
    raise exception 'Este comodo exige entre % e % pessoa(s).',
      target_area.min_cleaners,
      target_area.max_cleaners;
  end if;

  if exists (
    select 1
    from unnest(cleaner_member_ids) as provided(member_id)
    where not exists (
      select 1
      from public.house_cleaning_rotation_members rotation
      join public.household_members member
        on member.household_id = rotation.household_id
       and member.id = rotation.member_id
       and member.active = true
      where rotation.area_id = target_area.id
        and rotation.member_id = provided.member_id
    )
  ) then
    raise exception 'Uma das pessoas selecionadas nao pode limpar este comodo.';
  end if;

  select count(*)::integer
    into eligible_member_count
  from public.house_cleaning_rotation_members rotation
  join public.household_members member
    on member.household_id = rotation.household_id
   and member.id = rotation.member_id
   and member.active = true
  where rotation.area_id = target_area.id;

  if eligible_member_count < target_area.min_cleaners then
    raise exception 'Nao ha moradores ativos suficientes para esta regra de limpeza.';
  end if;

  if not public.has_permission('manage_house_map')
    and not (acting_profile.member_id = any(cleaner_member_ids)) then
    raise exception 'Voce so pode registrar uma limpeza da qual participou.';
  end if;

  -- Em modos livres a ordem do payload nao vira parte do historico. No modo
  -- sequencial ela precisa ser preservada porque pode atravessar o fim da fila.
  if target_area.cleaning_mode = 'round_robin' then
    resolved_member_ids := cleaner_member_ids;
  else
    select coalesce(
      array_agg(rotation.member_id order by rotation.rotation_order),
      array[]::uuid[]
    )
      into resolved_member_ids
    from public.house_cleaning_rotation_members rotation
    where rotation.area_id = target_area.id
      and rotation.member_id = any(cleaner_member_ids);
  end if;

  if target_area.cleaning_mode = 'fixed' then
    select coalesce(
      array_agg(rotation.member_id order by rotation.rotation_order),
      array[]::uuid[]
    )
      into current_suggestion
    from public.house_cleaning_rotation_members rotation
    join public.household_members member
      on member.household_id = rotation.household_id
     and member.id = rotation.member_id
     and member.active = true
    where rotation.area_id = target_area.id;

    if resolved_member_ids is distinct from current_suggestion then
      raise exception 'Este comodo possui uma pessoa responsavel fixa.';
    end if;
  elsif target_area.cleaning_mode = 'round_robin' then
    current_suggestion := target_area.suggested_member_ids;
    if cardinality(current_suggestion) = 0 then
      current_suggestion := public.house_cleaning_round_robin_team(
        target_area.id,
        target_area.current_start_member_id,
        target_area.people_per_turn,
        target_area.allow_incomplete_last_group
      );
    end if;

    if resolved_member_ids is distinct from current_suggestion then
      raise exception 'A equipe da vez mudou. Atualize a pagina antes de registrar a limpeza.';
    end if;
  end if;

  select coalesce(
    array_agg(member.name order by provided.position),
    array[]::text[]
  )
    into resolved_member_names
  from unnest(resolved_member_ids) with ordinality
    as provided(member_id, position)
  join public.household_members member
    on member.household_id = acting_profile.household_id
   and member.id = provided.member_id;

  -- Insere primeiro para que o balanceamento considere esta limpeza ao
  -- calcular quem esta faltando participar.
  insert into public.house_cleaning_history (
    area_id,
    household_id,
    turn_number,
    cleaned_on,
    cleaned_at,
    member_ids_snapshot,
    member_names_snapshot,
    next_member_ids_snapshot,
    next_member_names_snapshot,
    confirmed_by,
    note
  ) values (
    target_area.id,
    acting_profile.household_id,
    target_area.turn_number,
    resolved_cleaning_date,
    now(),
    resolved_member_ids,
    resolved_member_names,
    array[]::uuid[],
    array[]::text[],
    acting_profile.id,
    normalized_note
  )
  returning id into new_history_id;

  if target_area.cleaning_mode = 'fixed' then
    next_member_ids := resolved_member_ids;
  elsif target_area.cleaning_mode = 'balanced' then
    next_member_ids := public.house_cleaning_balanced_team(
      target_area.id,
      target_area.max_cleaners
    );
  elsif target_area.cleaning_mode = 'round_robin' then
    select coalesce(
      array_agg(member.id order by rotation.rotation_order),
      array[]::uuid[]
    )
      into active_ordered_member_ids
    from public.house_cleaning_rotation_members rotation
    join public.household_members member
      on member.household_id = rotation.household_id
     and member.id = rotation.member_id
     and member.active = true
    where rotation.area_id = target_area.id;

    current_start_index := array_position(
      active_ordered_member_ids,
      resolved_member_ids[1]
    );
    if current_start_index is null then
      raise exception 'A pessoa inicial atual nao esta ativa na ordem deste comodo.';
    end if;

    next_start_index := (
      (current_start_index - 1 + cardinality(resolved_member_ids))
      % cardinality(active_ordered_member_ids)
    ) + 1;
    next_start_member_id := active_ordered_member_ids[next_start_index];
    next_member_ids := public.house_cleaning_round_robin_team(
      target_area.id,
      next_start_member_id,
      target_area.people_per_turn,
      target_area.allow_incomplete_last_group
    );
  end if;

  select coalesce(
    array_agg(member.name order by provided.position),
    array[]::text[]
  )
    into next_member_names
  from unnest(next_member_ids) with ordinality
    as provided(member_id, position)
  join public.household_members member
    on member.household_id = acting_profile.household_id
   and member.id = provided.member_id;

  update public.house_cleaning_history
  set next_member_ids_snapshot = next_member_ids,
      next_member_names_snapshot = next_member_names
  where id = new_history_id;

  update public.house_cleaning_areas
  set suggested_member_ids = next_member_ids,
      current_start_member_id = case
        when cleaning_mode = 'flexible' then null
        else next_member_ids[1]
      end,
      current_since = now(),
      turn_number = target_area.turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where id = target_area.id;

  return new_history_id;
end;
$function$;

-- list_orphan_receipt_objects: exige a permissao manage_storage.
CREATE OR REPLACE FUNCTION public.list_orphan_receipt_objects(max_items integer DEFAULT 200)
 RETURNS TABLE(path text, size_bytes bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_storage') then
    raise exception 'Voce nao tem permissao para limpar o armazenamento.';
  end if;

  return query
  with referenced as (
    select distinct referenced_receipt_paths.path
    from public.referenced_receipt_paths()
  )
  select
    objects.name::text,
    coalesce((objects.metadata ->> 'size')::bigint, 0)
  from storage.objects objects
  where objects.bucket_id = 'comprovantes'
    and objects.name like acting_profile.household_id::text || '/%'
    and objects.created_at < now() - interval '24 hours'
    and not exists (
      select 1 from referenced where referenced.path = objects.name
    )
  order by objects.created_at
  limit least(greatest(coalesce(max_items, 200), 1), 500);
end;
$function$;

-- storage_usage_summary: exige a permissao manage_storage.
CREATE OR REPLACE FUNCTION public.storage_usage_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  household_prefix text;
  result jsonb;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_storage') then
    raise exception 'Voce nao tem permissao para consultar o uso do armazenamento.';
  end if;

  household_prefix := acting_profile.household_id::text || '/';

  with household_objects as (
    select
      objects.name,
      objects.created_at,
      coalesce((objects.metadata ->> 'size')::bigint, 0) as size_bytes
    from storage.objects objects
    where objects.bucket_id = 'comprovantes'
      and objects.name like household_prefix || '%'
  ),
  referenced as (
    select distinct referenced_receipt_paths.path
    from public.referenced_receipt_paths()
  ),
  orphans as (
    select household_objects.*
    from household_objects
    where household_objects.created_at < now() - interval '24 hours'
      and not exists (
        select 1 from referenced where referenced.path = household_objects.name
      )
  )
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'bucket_bytes', (select coalesce(sum(size_bytes), 0) from household_objects),
    'bucket_objects', (select count(*) from household_objects),
    'orphan_bytes', (select coalesce(sum(size_bytes), 0) from orphans),
    'orphan_objects', (select count(*) from orphans)
  )
  into result;

  return result;
end;
$function$;

-- record_daily_extra_task: exige a permissao manage_daily_rotation.
CREATE OR REPLACE FUNCTION public.record_daily_extra_task(target_date date, task_title text, task_description text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if not public.has_permission('manage_daily_rotation')
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
$function$;

-- toggle_daily_chore_completion: exige a permissao manage_daily_rotation.
CREATE OR REPLACE FUNCTION public.toggle_daily_chore_completion(target_date date, target_task_key text, mark_completed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if not public.has_permission('manage_daily_rotation')
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
$function$;

-- review_chore_day_swap: exige a permissao manage_daily_rotation.
CREATE OR REPLACE FUNCTION public.review_chore_day_swap(target_request_id uuid, approve_request boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if acting_profile.id is null or not public.has_permission('manage_daily_rotation') then
    raise exception 'Voce nao tem permissao para analisar trocas.';
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
$function$;

-- set_daily_rotation: exige a permissao manage_daily_rotation.
CREATE OR REPLACE FUNCTION public.set_daily_rotation(rotation_start_date date, ordered_member_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if acting_profile.id is null or not public.has_permission('manage_daily_rotation') then
    raise exception 'Voce nao tem permissao para configurar a escala.';
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
$function$;

-- set_laundry_rotation: exige a permissao manage_laundry.
CREATE OR REPLACE FUNCTION public.set_laundry_rotation(rotation_anchor_date date, rotation_anchor_member_id uuid, rotation_gap_days integer, rotation_people_per_day integer, rotation_allow_incomplete_last_group boolean, ordered_member_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  active_count integer;
  provided_count integer;
  distinct_count integer;
  anchor_position integer;
  local_today date := (now() at time zone 'America/Sao_Paulo')::date;
  new_version_id uuid;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or not public.has_permission('manage_laundry') then
    raise exception 'Voce nao tem permissao para configurar a lavanderia.';
  end if;
  if rotation_anchor_date is null then
    raise exception 'Informe a data de referência da escala.';
  end if;
  if rotation_gap_days is null or rotation_gap_days < 0 or rotation_gap_days > 30 then
    raise exception 'O intervalo deve estar entre 0 e 30 dias.';
  end if;
  if rotation_people_per_day is null
    or rotation_people_per_day < 1
    or rotation_people_per_day > 50 then
    raise exception 'A quantidade de pessoas por dia deve estar entre 1 e 50.';
  end if;
  if rotation_allow_incomplete_last_group is null then
    raise exception 'Informe como tratar o último grupo incompleto.';
  end if;

  -- Serializa mudanças concorrentes da mesma casa.
  perform 1
  from public.households
  where id = acting_profile.household_id
  for update;

  select count(*)::integer into active_count
  from public.household_members
  where household_id = acting_profile.household_id
    and active = true;

  select count(*)::integer, count(distinct provided.value)::integer
    into provided_count, distinct_count
  from unnest(ordered_member_ids) as provided(value);

  if provided_count = 0
    or provided_count <> active_count
    or distinct_count <> provided_count then
    raise exception 'A ordem deve conter todos os moradores ativos uma única vez.';
  end if;
  if rotation_people_per_day > provided_count then
    raise exception 'A quantidade por dia não pode superar o total de moradores.';
  end if;
  if rotation_anchor_member_id is null
    or not coalesce(rotation_anchor_member_id = any(ordered_member_ids), false) then
    raise exception 'O morador da data de referência precisa estar na escala.';
  end if;
  if exists (
    select 1
    from unnest(ordered_member_ids) as provided(value)
    where not exists (
      select 1
      from public.household_members member
      where member.id = provided.value
        and member.household_id = acting_profile.household_id
        and member.active = true
    )
  ) then
    raise exception 'A ordem contém um morador inválido ou inativo.';
  end if;

  select provided.position::integer into anchor_position
  from unnest(ordered_member_ids) with ordinality as provided(value, position)
  where provided.value = rotation_anchor_member_id;

  if rotation_allow_incomplete_last_group
    and mod(anchor_position - 1, rotation_people_per_day) <> 0 then
    raise exception 'Para grupos fixos, escolha como referência a primeira pessoa de um grupo.';
  end if;

  -- Substitui apenas uma eventual configuração salva anteriormente no mesmo
  -- dia. Versões anteriores são históricas e nunca são tocadas.
  delete from public.laundry_rotation_versions
  where household_id = acting_profile.household_id
    and effective_from = local_today;

  insert into public.laundry_rotation_versions (
    household_id,
    effective_from,
    anchor_date,
    anchor_member_id,
    gap_days,
    people_per_day,
    allow_incomplete_last_group,
    created_by
  ) values (
    acting_profile.household_id,
    local_today,
    rotation_anchor_date,
    rotation_anchor_member_id,
    rotation_gap_days,
    rotation_people_per_day,
    rotation_allow_incomplete_last_group,
    acting_profile.id
  )
  returning id into new_version_id;

  insert into public.laundry_rotation_version_members (
    version_id,
    household_id,
    member_id,
    member_name,
    member_initials,
    member_color_key,
    rotation_order
  )
  select
    new_version_id,
    acting_profile.household_id,
    provided.value,
    member.name,
    member.initials,
    member.color_key,
    provided.position::integer
  from unnest(ordered_member_ids) with ordinality as provided(value, position)
  join public.household_members member
    on member.id = provided.value
   and member.household_id = acting_profile.household_id;

  -- Espelho legado da configuração mais recente.
  insert into public.laundry_rotation_settings (
    household_id,
    effective_from,
    anchor_date,
    anchor_member_id,
    gap_days,
    people_per_day,
    allow_incomplete_last_group,
    updated_by,
    updated_at
  ) values (
    acting_profile.household_id,
    local_today,
    rotation_anchor_date,
    rotation_anchor_member_id,
    rotation_gap_days,
    rotation_people_per_day,
    rotation_allow_incomplete_last_group,
    acting_profile.id,
    now()
  )
  on conflict (household_id) do update
  set effective_from = excluded.effective_from,
      anchor_date = excluded.anchor_date,
      anchor_member_id = excluded.anchor_member_id,
      gap_days = excluded.gap_days,
      people_per_day = excluded.people_per_day,
      allow_incomplete_last_group = excluded.allow_incomplete_last_group,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  delete from public.laundry_rotation_members
  where household_id = acting_profile.household_id;

  insert into public.laundry_rotation_members (
    household_id,
    member_id,
    rotation_order
  )
  select
    acting_profile.household_id,
    provided.value,
    provided.position::integer
  from unnest(ordered_member_ids) with ordinality as provided(value, position);

  return new_version_id;
end;
$function$;

-- record_water_gallon_payment: exige a permissao manage_water.
CREATE OR REPLACE FUNCTION public.record_water_gallon_payment(payment_date date, payment_note text, expected_member_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  paid_member_id uuid;
  paid_member_name text;
  following_member_id uuid;
  following_member_name text;
  new_payment_id uuid;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_water') then
    raise exception 'Voce nao tem permissao para confirmar pagamentos do galao.';
  end if;
  if payment_date is null then
    raise exception 'Informe a data do pagamento.';
  end if;
  if payment_date > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'A data do pagamento nao pode estar no futuro.';
  end if;
  if char_length(trim(coalesce(payment_note, ''))) > 300 then
    raise exception 'A observacao deve ter no maximo 300 caracteres.';
  end if;
  if expected_member_id is null then
    raise exception 'Informe qual pessoa da vez esta sendo confirmada.';
  end if;

  select settings.current_member_id, member.name
    into paid_member_id, paid_member_name
  from public.water_gallon_rotation_settings settings
  join public.household_members member
    on member.household_id = settings.household_id
   and member.id = settings.current_member_id
   and member.active = true
  where settings.household_id = acting_profile.household_id
  for update of settings;

  if paid_member_id is null then
    raise exception 'Configure uma pessoa atual ativa no rodizio de agua.';
  end if;
  if paid_member_id is distinct from expected_member_id then
    raise exception 'A pessoa da vez mudou. Atualize a pagina antes de confirmar o pagamento.';
  end if;

  following_member_id := public.next_water_gallon_member(
    acting_profile.household_id,
    paid_member_id
  );
  if following_member_id is null then
    raise exception 'A ordem do rodizio nao possui uma proxima pessoa ativa.';
  end if;

  select name into following_member_name
  from public.household_members
  where household_id = acting_profile.household_id
    and id = following_member_id;

  insert into public.water_gallon_payments (
    household_id,
    member_id,
    member_name_snapshot,
    paid_on,
    source,
    next_member_id,
    next_member_name_snapshot,
    confirmed_by,
    note
  ) values (
    acting_profile.household_id,
    paid_member_id,
    paid_member_name,
    payment_date,
    'manual',
    following_member_id,
    following_member_name,
    acting_profile.id,
    nullif(trim(payment_note), '')
  )
  returning id into new_payment_id;

  update public.water_gallon_rotation_settings
  set current_member_id = following_member_id,
      current_since = now(),
      updated_by = acting_profile.id,
      updated_at = now()
  where household_id = acting_profile.household_id;

  return new_payment_id;
end;
$function$;

-- review_water_gallon_purchase: exige a permissao manage_water.
CREATE OR REPLACE FUNCTION public.review_water_gallon_purchase(target_purchase_id uuid, review_decision text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  current_member_id uuid;
  current_member_name text;
  current_started_at timestamptz;
  purchase_bought_at timestamptz;
  following_member_id uuid;
  following_member_name text;
  new_payment_id uuid;
  existing_decision text;
  existing_payment_id uuid;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_water') then
    raise exception 'Voce nao tem permissao para revisar sugestoes do galao.';
  end if;
  if review_decision is null or review_decision not in ('confirm', 'reject') then
    raise exception 'A decisao deve ser confirm ou reject.';
  end if;

  select settings.current_member_id, settings.current_since, member.name
    into current_member_id, current_started_at, current_member_name
  from public.water_gallon_rotation_settings settings
  join public.household_members member
    on member.household_id = settings.household_id
   and member.id = settings.current_member_id
   and member.active = true
  where settings.household_id = acting_profile.household_id
  for update of settings;

  if current_member_id is null then
    raise exception 'Configure uma pessoa atual ativa no rodizio de agua.';
  end if;

  -- Uma resposta pode se perder depois do commit e fazer o cliente repetir a
  -- mesma decisao. Retornar o resultado ja salvo evita erro falso e, acima de
  -- tudo, impede qualquer segundo avanco do rodizio.
  select review.decision, review.payment_id
    into existing_decision, existing_payment_id
  from public.water_gallon_purchase_reviews review
  where review.purchase_id = target_purchase_id
    and review.household_id = acting_profile.household_id;

  if found then
    if (review_decision = 'confirm' and existing_decision = 'confirmed')
      or (review_decision = 'reject' and existing_decision = 'rejected') then
      return existing_payment_id;
    end if;
    raise exception 'Esta compra ja foi revisada com outra decisao.';
  end if;

  select purchase.bought_at
    into purchase_bought_at
  from public.shopping_purchases purchase
  where purchase.id = target_purchase_id
    and purchase.household_id = acting_profile.household_id
    and purchase.paid_by_member_id = current_member_id
    and purchase.bought_at >= current_started_at
    and exists (
      select 1
      from public.shopping_items item
      where item.purchase_id = purchase.id
        and public.is_water_gallon_item_name(item.name)
    )
  for update of purchase;

  if purchase_bought_at is null then
    raise exception 'Esta compra nao e mais uma sugestao valida para a pessoa da vez.';
  end if;
  if review_decision = 'reject' then
    insert into public.water_gallon_purchase_reviews (
      purchase_id,
      household_id,
      matched_member_id,
      matched_member_name_snapshot,
      decision,
      decided_by
    ) values (
      target_purchase_id,
      acting_profile.household_id,
      current_member_id,
      current_member_name,
      'rejected',
      acting_profile.id
    );

    return null;
  end if;

  following_member_id := public.next_water_gallon_member(
    acting_profile.household_id,
    current_member_id
  );
  if following_member_id is null then
    raise exception 'A ordem do rodizio nao possui uma proxima pessoa ativa.';
  end if;

  select name into following_member_name
  from public.household_members
  where household_id = acting_profile.household_id
    and id = following_member_id;

  insert into public.water_gallon_payments (
    household_id,
    member_id,
    member_name_snapshot,
    paid_on,
    source,
    purchase_id,
    next_member_id,
    next_member_name_snapshot,
    confirmed_by,
    note
  ) values (
    acting_profile.household_id,
    current_member_id,
    current_member_name,
    (purchase_bought_at at time zone 'America/Sao_Paulo')::date,
    'shopping_purchase',
    target_purchase_id,
    following_member_id,
    following_member_name,
    acting_profile.id,
    'Pagamento confirmado a partir de uma compra sugerida.'
  )
  returning id into new_payment_id;

  insert into public.water_gallon_purchase_reviews (
    purchase_id,
    household_id,
    matched_member_id,
    matched_member_name_snapshot,
    decision,
    payment_id,
    decided_by
  ) values (
    target_purchase_id,
    acting_profile.household_id,
    current_member_id,
    current_member_name,
    'confirmed',
    new_payment_id,
    acting_profile.id
  );

  update public.water_gallon_rotation_settings
  set current_member_id = following_member_id,
      current_since = now(),
      updated_by = acting_profile.id,
      updated_at = now()
  where household_id = acting_profile.household_id;

  return new_payment_id;
end;
$function$;

-- set_water_gallon_current_member: exige a permissao manage_water.
CREATE OR REPLACE FUNCTION public.set_water_gallon_current_member(target_member_id uuid, change_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    or not public.has_permission('manage_water') then
    raise exception 'Voce nao tem permissao para alterar a pessoa da vez.';
  end if;
  if char_length(trim(coalesce(change_note, ''))) > 300 then
    raise exception 'O motivo deve ter no maximo 300 caracteres.';
  end if;

  select settings.current_member_id
    into previous_member_id
  from public.water_gallon_rotation_settings settings
  where settings.household_id = acting_profile.household_id
  for update;

  if not found then
    raise exception 'Configure primeiro a ordem do rodizio de agua.';
  end if;

  if not exists (
    select 1
    from public.water_gallon_rotation_members rotation
    join public.household_members member
      on member.household_id = rotation.household_id
     and member.id = rotation.member_id
    where rotation.household_id = acting_profile.household_id
      and rotation.member_id = target_member_id
      and member.active = true
  ) then
    raise exception 'A pessoa escolhida nao esta ativa na ordem do rodizio.';
  end if;

  select array_agg(rotation.member_id order by rotation.rotation_order)
    into ordered_ids
  from public.water_gallon_rotation_members rotation
  where rotation.household_id = acting_profile.household_id;

  update public.water_gallon_rotation_settings
  set current_member_id = target_member_id,
      current_since = case
        when current_member_id is distinct from target_member_id then now()
        else current_since
      end,
      updated_by = acting_profile.id,
      updated_at = now()
  where household_id = acting_profile.household_id;

  insert into public.water_gallon_rotation_changes (
    household_id,
    change_type,
    previous_current_member_id,
    current_member_id,
    ordered_member_ids,
    note,
    changed_by
  ) values (
    acting_profile.household_id,
    'current_member_changed',
    previous_member_id,
    target_member_id,
    coalesce(ordered_ids, array[]::uuid[]),
    nullif(trim(change_note), ''),
    acting_profile.id
  );
end;
$function$;

-- set_water_gallon_rotation: exige a permissao manage_water.
CREATE OR REPLACE FUNCTION public.set_water_gallon_rotation(ordered_member_ids uuid[], target_current_member_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  active_member_count integer;
  provided_member_count integer;
  distinct_member_count integer;
  previous_current_member_id uuid;
  previous_current_since timestamptz;
  resolved_current_member_id uuid;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('manage_water') then
    raise exception 'Voce nao tem permissao para configurar o rodizio de agua.';
  end if;

  select count(*)::integer into active_member_count
  from public.household_members
  where household_id = acting_profile.household_id
    and active = true;

  select count(*)::integer, count(distinct provided.member_id)::integer
    into provided_member_count, distinct_member_count
  from unnest(coalesce(ordered_member_ids, array[]::uuid[]))
    as provided(member_id);

  if active_member_count = 0
    or provided_member_count <> active_member_count
    or distinct_member_count <> provided_member_count then
    raise exception 'A ordem deve conter todos os moradores ativos uma unica vez.';
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

  select settings.current_member_id, settings.current_since
    into previous_current_member_id, previous_current_since
  from public.water_gallon_rotation_settings settings
  where settings.household_id = acting_profile.household_id
  for update;

  resolved_current_member_id := coalesce(
    target_current_member_id,
    case
      when previous_current_member_id = any(ordered_member_ids)
        then previous_current_member_id
      else null
    end,
    ordered_member_ids[1]
  );

  if not (resolved_current_member_id = any(ordered_member_ids)) then
    raise exception 'A pessoa atual precisa fazer parte da ordem.';
  end if;

  insert into public.water_gallon_rotation_settings (
    household_id,
    current_member_id,
    current_since,
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
    acting_profile.id,
    now()
  )
  on conflict (household_id) do update
  set current_member_id = excluded.current_member_id,
      current_since = excluded.current_since,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;

  delete from public.water_gallon_rotation_members
  where household_id = acting_profile.household_id;

  insert into public.water_gallon_rotation_members (
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

  insert into public.water_gallon_rotation_changes (
    household_id,
    change_type,
    previous_current_member_id,
    current_member_id,
    ordered_member_ids,
    changed_by
  ) values (
    acting_profile.household_id,
    'order_updated',
    previous_current_member_id,
    resolved_current_member_id,
    ordered_member_ids,
    acting_profile.id
  );
end;
$function$;

-- set_stove_cleaning_current_member: exige a permissao manage_stove_dish.
CREATE OR REPLACE FUNCTION public.set_stove_cleaning_current_member(target_member_id uuid, change_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    or not public.has_permission('manage_stove_dish') then
    raise exception 'Voce nao tem permissao para alterar a pessoa da vez.';
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
$function$;

-- set_stove_cleaning_rotation: exige a permissao manage_stove_dish.
CREATE OR REPLACE FUNCTION public.set_stove_cleaning_rotation(ordered_member_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    or not public.has_permission('manage_stove_dish') then
    raise exception 'Voce nao tem permissao para configurar o rodizio do fogao.';
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
$function$;

-- set_dish_rack_cleaning_current_member: exige a permissao manage_stove_dish.
CREATE OR REPLACE FUNCTION public.set_dish_rack_cleaning_current_member(target_member_id uuid, change_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    or not public.has_permission('manage_stove_dish') then
    raise exception 'Voce nao tem permissao para alterar a pessoa da vez.';
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
$function$;

-- set_expense_share_payment: exige a permissao record_payments_without_receipt.
CREATE OR REPLACE FUNCTION public.set_expense_share_payment(target_share_id uuid, target_status text, target_paid_amount numeric, record_as_admin boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  acting_profile public.profiles%rowtype;
  target_share public.expense_shares%rowtype;
  target_expense_id uuid;
  saved_paid_amount numeric(12,2);
begin
  select profile.*
  into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('mark_expenses_paid') then
    raise exception 'Você não tem permissão para alterar pagamentos.';
  end if;
  if target_status is null or target_status not in ('paid', 'pending') then
    raise exception 'Status de pagamento inválido.';
  end if;
  if coalesce(record_as_admin, false)
    and not public.has_permission('record_payments_without_receipt') then
    raise exception 'Voce nao tem permissao para registrar pagamentos manuais.';
  end if;

  select share_row.expense_id
  into target_expense_id
  from public.expense_shares share_row
  join public.expenses expense on expense.id = share_row.expense_id
  where share_row.id = target_share_id
    and expense.household_id = acting_profile.household_id;

  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;

  -- Todas as mutações de uma despesa seguem a mesma ordem de locks usada
  -- por save_expense_with_shares: primeiro o pai, depois suas parcelas.
  perform 1
  from public.expenses expense
  where expense.id = target_expense_id
    and expense.household_id = acting_profile.household_id
  for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;

  select share_row.*
  into target_share
  from public.expense_shares share_row
  where share_row.id = target_share_id
    and share_row.expense_id = target_expense_id
  for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;

  if target_status = 'paid' then
    if not coalesce(record_as_admin, false)
      and nullif(btrim(target_share.receipt_path), '') is null then
      raise exception 'Anexe o comprovante antes de marcar esta parcela como paga.';
    end if;

    saved_paid_amount := round(
      coalesce(target_paid_amount, target_share.amount),
      2
    );
    if saved_paid_amount <= 0 then
      raise exception 'Informe um valor pago maior que zero.';
    end if;
    if saved_paid_amount > target_share.amount then
      raise exception 'O valor pago não pode ultrapassar o valor da parcela.';
    end if;
    if not coalesce(record_as_admin, false)
      and saved_paid_amount is distinct from target_share.amount then
      raise exception 'Voce nao tem permissao para alterar o valor efetivamente pago.';
    end if;
  else
    saved_paid_amount := null;
  end if;

  update public.expense_shares
  set payment_status = target_status::public.share_status,
      paid_amount = saved_paid_amount,
      paid_at = case when target_status = 'paid' then now() else null end,
      payment_method = case
        when target_status <> 'paid' then null
        when coalesce(record_as_admin, false)
          then 'Registro manual do administrador'
        else 'Mercado Pago / Pix'
      end,
      payment_recorded_by = case
        when target_status = 'paid' then acting_profile.id
        else null
      end
  where id = target_share.id;

  update public.expenses expense
  set status = case
    when expense.amount is null then 'planned'::public.expense_status
    when exists (
      select 1
      from public.expense_shares share_row
      where share_row.expense_id = target_expense_id
    ) and not exists (
      select 1
      from public.expense_shares share_row
      where share_row.expense_id = target_expense_id
        and share_row.payment_status not in (
          'paid'::public.share_status,
          'waived'::public.share_status
        )
    ) then 'paid'::public.expense_status
    else 'open'::public.expense_status
  end
  where expense.id = target_expense_id;

  return target_expense_id;
end;
$function$;

-- require_expense_receipt_before_paid: exige a permissao record_payments_without_receipt.
CREATE OR REPLACE FUNCTION public.require_expense_receipt_before_paid()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  acting_is_admin boolean := false;
begin
  select exists (
    select 1
    from public.profiles profile
    join public.expenses expense on expense.id = new.expense_id
    where profile.id = auth.uid()
      and profile.status = 'active'
      and public.has_permission('record_payments_without_receipt')
      and profile.household_id = expense.household_id
  ) into acting_is_admin;

  if new.payment_status = 'paid'::public.share_status then
    if nullif(btrim(new.receipt_path), '') is null and not acting_is_admin then
      raise exception 'Anexe o comprovante antes de marcar esta parcela como paga.';
    end if;

    if new.paid_amount is null and new.receipt_path is not null then
      new.paid_amount := new.amount;
    end if;
    if new.paid_amount is null or new.paid_amount <= 0 then
      raise exception 'Informe um valor pago maior que zero.';
    end if;
    if new.paid_amount > new.amount then
      raise exception 'O valor pago não pode ultrapassar o valor da parcela.';
    end if;
    if not acting_is_admin and new.paid_amount is distinct from new.amount then
      raise exception 'Voce nao tem permissao para alterar o valor efetivamente pago.';
    end if;
  else
    new.paid_amount := null;
    new.payment_recorded_by := null;
  end if;

  return new;
end;
$function$;

-- confirm_shopping_net_payment: exige a permissao manage_shopping_settlements.
CREATE OR REPLACE FUNCTION public.confirm_shopping_net_payment(target_payment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  payment_row public.shopping_settlement_payments%rowtype;
  gross_outgoing_cents bigint;
  gross_incoming_cents bigint;
  net_cents bigint;
  paid_cents bigint;
  reciprocal_cents bigint;
begin
  select payment.* into payment_row
  from public.shopping_settlement_payments payment
  join public.profiles profile on profile.id = auth.uid()
  where payment.id = target_payment_id
    and payment.status = 'pending'
    and payment.payment_kind = 'pix'
    and payment.receipt_path is not null
    and profile.status = 'active'
    and profile.household_id = payment.household_id
    and (
      profile.member_id = payment.creditor_member_id
      or public.has_permission('manage_shopping_settlements')
    )
  for update of payment;

  if payment_row.id is null then
    raise exception 'Pagamento sem comprovante, já confirmado ou sem permissão.';
  end if;

  select coalesce(sum(round((share.amount - share.settled_amount) * 100)), 0)::bigint
    into gross_outgoing_cents
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.member_id = payment_row.debtor_member_id
    and purchase.paid_by_member_id = payment_row.creditor_member_id
    and purchase.household_id = payment_row.household_id
    and share.payment_status = 'pending'::public.share_status
    and share.created_at <= payment_row.submitted_at;

  select coalesce(sum(round((share.amount - share.settled_amount) * 100)), 0)::bigint
    into gross_incoming_cents
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.member_id = payment_row.creditor_member_id
    and purchase.paid_by_member_id = payment_row.debtor_member_id
    and purchase.household_id = payment_row.household_id
    and share.payment_status = 'pending'::public.share_status
    and share.created_at <= payment_row.submitted_at;

  paid_cents := round(payment_row.amount * 100)::bigint;
  net_cents := gross_outgoing_cents - gross_incoming_cents;

  if paid_cents <= 0 then
    raise exception 'O valor deste pagamento é inválido.';
  end if;
  if net_cents <= 0 then
    raise exception 'Este acerto não possui mais saldo líquido a pagar.';
  end if;
  if paid_cents > net_cents then
    raise exception 'O saldo atual é menor que o valor informado neste comprovante.';
  end if;

  -- Em pagamento parcial, baixa exatamente o valor do comprovante e mantém
  -- todas as demais parcelas abertas.
  perform public.apply_shopping_settlement_amount(
    payment_row.household_id,
    payment_row.debtor_member_id,
    payment_row.creditor_member_id,
    paid_cents,
    payment_row.submitted_at
  );

  -- Se o Pix completou o saldo líquido, as dívidas restantes possuem o mesmo
  -- valor. Nesse momento elas podem ser fechadas por compensação, sem cobrar
  -- qualquer valor além do comprovante.
  if paid_cents = net_cents then
    reciprocal_cents := gross_incoming_cents;
    if reciprocal_cents > 0 then
      perform public.apply_shopping_settlement_amount(
        payment_row.household_id,
        payment_row.debtor_member_id,
        payment_row.creditor_member_id,
        reciprocal_cents,
        payment_row.submitted_at
      );
      perform public.apply_shopping_settlement_amount(
        payment_row.household_id,
        payment_row.creditor_member_id,
        payment_row.debtor_member_id,
        reciprocal_cents,
        payment_row.submitted_at
      );
    end if;
  end if;

  update public.shopping_settlement_payments
  set status = 'confirmed',
      confirmed_by = auth.uid(),
      confirmed_at = now()
  where id = payment_row.id;

  -- O comprovante permanece preservado no histórico. A referência legada da
  -- parcela é limpa para permitir o próximo comprovante do saldo restante.
  update public.shopping_purchase_shares
  set receipt_path = null,
      receipt_name = null,
      receipt_uploaded_by = null,
      receipt_uploaded_at = null
  where id = payment_row.target_share_id;
end;
$function$;

-- confirm_shopping_share_payment: exige a permissao manage_shopping_settlements.
CREATE OR REPLACE FUNCTION public.confirm_shopping_share_payment(target_share_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.shopping_item_shares s
  set payment_status = 'paid',
      paid_at = now()
  from public.shopping_items i, public.profiles p
  where s.id = target_share_id
    and i.id = s.shopping_item_id
    and p.id = auth.uid()
    and p.status = 'active'
    and p.household_id = i.household_id
    and s.receipt_path is not null
    and (
      p.member_id = i.paid_by_member_id
      or public.has_permission('manage_shopping_settlements')
      or coalesce((p.permissions ->> 'manage_shopping')::boolean, false)
    );

  if not found then
    raise exception 'Pagamento sem comprovante ou sem permissão para confirmação.';
  end if;
end;
$function$;

-- submit_shopping_net_receipt: exige a permissao manage_shopping_settlements.
CREATE OR REPLACE FUNCTION public.submit_shopping_net_receipt(target_share_id uuid, uploaded_path text, uploaded_name text, paid_amount numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_target_share_id uuid := target_share_id;
  v_debtor_member_id uuid;
  v_creditor_member_id uuid;
  v_household_id uuid;
  v_gross_outgoing_cents bigint;
  v_gross_incoming_cents bigint;
  v_net_cents bigint;
  v_paid_cents bigint;
  v_new_payment_id uuid;
begin
  select share.member_id, purchase.paid_by_member_id, purchase.household_id
    into v_debtor_member_id, v_creditor_member_id, v_household_id
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  join public.profiles profile on profile.id = auth.uid()
  where share.id = v_target_share_id
    and share.payment_status = 'pending'::public.share_status
    and share.amount > share.settled_amount
    and profile.status = 'active'
    and profile.household_id = purchase.household_id
    and (
      profile.member_id = share.member_id
      or public.has_permission('manage_shopping_settlements')
    )
    and share.member_id <> purchase.paid_by_member_id
  for update of share;

  if v_debtor_member_id is null then
    raise exception 'Dívida não encontrada ou sem permissão para enviar o comprovante.';
  end if;
  if uploaded_path not like v_household_id::text || '/shopping-net/' || v_target_share_id::text || '/%' then
    raise exception 'Caminho do comprovante inválido.';
  end if;

  v_paid_cents := round(paid_amount * 100)::bigint;
  if paid_amount is null or v_paid_cents <= 0 then
    raise exception 'Informe um valor pago maior que zero.';
  end if;

  if exists (
    select 1
    from public.shopping_settlement_payments pending_payment
    where pending_payment.household_id = v_household_id
      and pending_payment.status = 'pending'
      and (
        (
          pending_payment.debtor_member_id = v_debtor_member_id
          and pending_payment.creditor_member_id = v_creditor_member_id
        )
        or (
          pending_payment.debtor_member_id = v_creditor_member_id
          and pending_payment.creditor_member_id = v_debtor_member_id
        )
      )
  ) then
    raise exception 'Já existe um comprovante aguardando confirmação para este acerto.';
  end if;

  select coalesce(sum(round((share.amount - share.settled_amount) * 100)), 0)::bigint
    into v_gross_outgoing_cents
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.member_id = v_debtor_member_id
    and purchase.paid_by_member_id = v_creditor_member_id
    and purchase.household_id = v_household_id
    and share.payment_status = 'pending'::public.share_status;

  select coalesce(sum(round((share.amount - share.settled_amount) * 100)), 0)::bigint
    into v_gross_incoming_cents
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.member_id = v_creditor_member_id
    and purchase.paid_by_member_id = v_debtor_member_id
    and purchase.household_id = v_household_id
    and share.payment_status = 'pending'::public.share_status;

  v_net_cents := v_gross_outgoing_cents - v_gross_incoming_cents;
  if v_net_cents <= 0 then
    raise exception 'Após a compensação, esta pessoa não possui saldo a pagar.';
  end if;
  if v_paid_cents > v_net_cents then
    raise exception 'O valor pago não pode ultrapassar o saldo líquido em aberto.';
  end if;

  insert into public.shopping_settlement_payments (
    household_id,
    debtor_member_id,
    creditor_member_id,
    target_share_id,
    amount,
    payment_kind,
    status,
    receipt_path,
    receipt_name,
    submitted_by,
    submitted_at
  ) values (
    v_household_id,
    v_debtor_member_id,
    v_creditor_member_id,
    v_target_share_id,
    v_paid_cents / 100.0,
    'pix',
    'pending',
    uploaded_path,
    uploaded_name,
    auth.uid(),
    now()
  ) returning id into v_new_payment_id;

  update public.shopping_purchase_shares share
  set receipt_path = uploaded_path,
      receipt_name = uploaded_name,
      receipt_uploaded_by = auth.uid(),
      receipt_uploaded_at = now()
  where share.id = v_target_share_id;

  return v_new_payment_id;
end;
$function$;

-- record_shopping_net_payment_as_admin: exige a permissao manage_shopping_settlements.
CREATE OR REPLACE FUNCTION public.record_shopping_net_payment_as_admin(target_share_id uuid, paid_amount numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_target_share_id uuid := target_share_id;
  v_admin_profile public.profiles%rowtype;
  v_debtor_member_id uuid;
  v_creditor_member_id uuid;
  v_household_id uuid;
  v_gross_outgoing_cents bigint;
  v_gross_incoming_cents bigint;
  v_net_cents bigint;
  v_paid_cents bigint;
  v_reciprocal_cents bigint;
  v_payment_id uuid;
  v_cutoff timestamptz := now();
begin
  select profile.* into v_admin_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and public.has_permission('manage_shopping_settlements')
    and profile.household_id is not null;

  if v_admin_profile.id is null then
    raise exception 'Voce nao tem permissao para registrar um pagamento sem comprovante.';
  end if;

  select share.member_id, purchase.paid_by_member_id, purchase.household_id
    into v_debtor_member_id, v_creditor_member_id, v_household_id
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.id = v_target_share_id
    and share.payment_status = 'pending'::public.share_status
    and share.amount > share.settled_amount
    and purchase.household_id = v_admin_profile.household_id
    and share.member_id <> purchase.paid_by_member_id
  for update of share;

  if v_debtor_member_id is null then
    raise exception 'Acerto em aberto não encontrado.';
  end if;

  v_paid_cents := round(paid_amount * 100)::bigint;
  if paid_amount is null or v_paid_cents <= 0 then
    raise exception 'Informe um valor pago maior que zero.';
  end if;

  if exists (
    select 1
    from public.shopping_settlement_payments pending_payment
    where pending_payment.household_id = v_household_id
      and pending_payment.status = 'pending'
      and (
        (
          pending_payment.debtor_member_id = v_debtor_member_id
          and pending_payment.creditor_member_id = v_creditor_member_id
        )
        or (
          pending_payment.debtor_member_id = v_creditor_member_id
          and pending_payment.creditor_member_id = v_debtor_member_id
        )
      )
  ) then
    raise exception 'Já existe um comprovante aguardando confirmação para este acerto.';
  end if;

  select coalesce(sum(round((share.amount - share.settled_amount) * 100)), 0)::bigint
    into v_gross_outgoing_cents
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.member_id = v_debtor_member_id
    and purchase.paid_by_member_id = v_creditor_member_id
    and purchase.household_id = v_household_id
    and share.payment_status = 'pending'::public.share_status;

  select coalesce(sum(round((share.amount - share.settled_amount) * 100)), 0)::bigint
    into v_gross_incoming_cents
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.member_id = v_creditor_member_id
    and purchase.paid_by_member_id = v_debtor_member_id
    and purchase.household_id = v_household_id
    and share.payment_status = 'pending'::public.share_status;

  v_net_cents := v_gross_outgoing_cents - v_gross_incoming_cents;
  if v_net_cents <= 0 then
    raise exception 'Após a compensação, esta pessoa não possui saldo a pagar.';
  end if;
  if v_paid_cents > v_net_cents then
    raise exception 'O valor pago não pode ultrapassar o saldo líquido em aberto.';
  end if;

  insert into public.shopping_settlement_payments (
    household_id,
    debtor_member_id,
    creditor_member_id,
    target_share_id,
    amount,
    payment_kind,
    status,
    submitted_by,
    submitted_at,
    confirmed_by,
    confirmed_at
  ) values (
    v_household_id,
    v_debtor_member_id,
    v_creditor_member_id,
    v_target_share_id,
    v_paid_cents / 100.0,
    'admin_manual',
    'confirmed',
    auth.uid(),
    v_cutoff,
    auth.uid(),
    v_cutoff
  ) returning id into v_payment_id;

  -- Pagamentos parciais baixam apenas o valor informado.
  perform public.apply_shopping_settlement_amount(
    v_household_id,
    v_debtor_member_id,
    v_creditor_member_id,
    v_paid_cents,
    v_cutoff
  );

  -- Quando o pagamento completa o saldo líquido, fecha também a parte que se
  -- compensa nos dois sentidos, sem aumentar o valor registrado como pago.
  if v_paid_cents = v_net_cents then
    v_reciprocal_cents := v_gross_incoming_cents;
    if v_reciprocal_cents > 0 then
      perform public.apply_shopping_settlement_amount(
        v_household_id,
        v_debtor_member_id,
        v_creditor_member_id,
        v_reciprocal_cents,
        v_cutoff
      );
      perform public.apply_shopping_settlement_amount(
        v_household_id,
        v_creditor_member_id,
        v_debtor_member_id,
        v_reciprocal_cents,
        v_cutoff
      );
    end if;
  end if;

  return v_payment_id;
end;
$function$;

-- settle_zero_shopping_balance_as_admin: exige a permissao manage_shopping_settlements.
CREATE OR REPLACE FUNCTION public.settle_zero_shopping_balance_as_admin(first_member_id uuid, second_member_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target_household_id uuid;
  valid_member_count integer;
  first_owes_second_cents bigint;
  second_owes_first_cents bigint;
begin
  if first_member_id = second_member_id then
    raise exception 'Informe dois moradores diferentes.';
  end if;

  select household_id into target_household_id
  from public.profiles
  where id = auth.uid() and status = 'active' and public.has_permission('manage_shopping_settlements');
  if target_household_id is null then
    raise exception 'Voce nao tem permissao para quitar acertos de outros moradores.';
  end if;

  select count(*) into valid_member_count
  from public.household_members
  where household_id = target_household_id
    and active = true
    and id in (first_member_id, second_member_id);
  if valid_member_count <> 2 then
    raise exception 'Um dos moradores não pertence a esta casa.';
  end if;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into first_owes_second_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = first_member_id
    and p.paid_by_member_id = second_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  select coalesce(sum(round((s.amount - s.settled_amount) * 100)), 0)::bigint
    into second_owes_first_cents
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = second_member_id
    and p.paid_by_member_id = first_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'::public.share_status;

  if first_owes_second_cents = 0 or first_owes_second_cents <> second_owes_first_cents then
    raise exception 'As dívidas não possuem o mesmo valor para quitação por compensação.';
  end if;

  insert into public.shopping_settlement_payments (
    household_id, debtor_member_id, creditor_member_id, amount,
    payment_kind, status, submitted_by, submitted_at, confirmed_by, confirmed_at
  ) values (
    target_household_id, first_member_id, second_member_id, 0,
    'compensation', 'confirmed', auth.uid(), now(), auth.uid(), now()
  );

  perform public.apply_shopping_settlement_amount(
    target_household_id, first_member_id, second_member_id,
    first_owes_second_cents, now()
  );
  perform public.apply_shopping_settlement_amount(
    target_household_id, second_member_id, first_member_id,
    first_owes_second_cents, now()
  );
end;
$function$;
