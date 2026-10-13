-- Mapa interativo da limpeza da casa. Cada comodo possui sua propria ordem,
-- tamanho de equipe e turno atual. As escritas do cliente passam somente pelas
-- funcoes SECURITY DEFINER desta migration.

create table if not exists public.house_cleaning_areas (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  slug text not null,
  name text not null check (char_length(trim(name)) > 0),
  display_order integer not null check (display_order > 0),
  active boolean not null default true,
  people_per_turn integer not null default 2 check (people_per_turn between 1 and 2),
  allow_incomplete_last_group boolean not null default true,
  current_start_member_id uuid,
  current_since timestamptz not null default now(),
  turn_number bigint not null default 1 check (turn_number > 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (household_id, slug),
  unique (household_id, id),
  foreign key (household_id, current_start_member_id)
    references public.household_members(household_id, id)
    on delete set null (current_start_member_id)
);

-- Recria o CHECK tambem quando uma versao anterior desta migration tiver sido
-- executada antes da inclusao da Copa.
alter table public.house_cleaning_areas
  drop constraint if exists house_cleaning_areas_slug_check;
alter table public.house_cleaning_areas
  add constraint house_cleaning_areas_slug_check check (slug in (
    'sala',
    'quarto_1',
    'quarto_2',
    'suite',
    'banheiro_social',
    'banheiro_suite',
    'corredor',
    'copa',
    'cozinha',
    'area_servico',
    'quarto_fundos',
    'banheiro_servico'
  ));

create table if not exists public.house_cleaning_rotation_members (
  area_id uuid not null,
  household_id uuid not null,
  member_id uuid not null,
  rotation_order integer not null check (rotation_order > 0),
  primary key (area_id, member_id),
  unique (area_id, rotation_order),
  foreign key (household_id, area_id)
    references public.house_cleaning_areas(household_id, id) on delete cascade,
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

-- IDs e nomes sao snapshots: o historico continua legivel mesmo se um
-- morador for renomeado ou deixar a casa posteriormente.
create table if not exists public.house_cleaning_history (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null,
  household_id uuid not null,
  turn_number bigint not null check (turn_number > 0),
  cleaned_on date not null,
  cleaned_at timestamptz not null default now(),
  member_ids_snapshot uuid[] not null,
  member_names_snapshot text[] not null,
  next_member_ids_snapshot uuid[] not null,
  next_member_names_snapshot text[] not null,
  confirmed_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  unique (area_id, turn_number),
  foreign key (household_id, area_id)
    references public.house_cleaning_areas(household_id, id) on delete cascade,
  constraint house_cleaning_history_current_team_size check (
    cardinality(member_ids_snapshot) between 1 and 2
    and cardinality(member_names_snapshot) = cardinality(member_ids_snapshot)
  ),
  constraint house_cleaning_history_next_team_size check (
    cardinality(next_member_ids_snapshot) between 1 and 2
    and cardinality(next_member_names_snapshot) = cardinality(next_member_ids_snapshot)
  ),
  constraint house_cleaning_history_note_length check (
    note is null or char_length(note) <= 300
  )
);

create index if not exists house_cleaning_areas_household_order_idx
  on public.house_cleaning_areas(household_id, active desc, display_order, id);
create index if not exists house_cleaning_rotation_order_idx
  on public.house_cleaning_rotation_members(area_id, rotation_order);
create index if not exists house_cleaning_rotation_household_order_idx
  on public.house_cleaning_rotation_members(household_id, area_id, rotation_order);
create index if not exists house_cleaning_history_household_idx
  on public.house_cleaning_history(household_id, cleaned_on desc, cleaned_at desc);
create index if not exists house_cleaning_history_area_recent_idx
  on public.house_cleaning_history(
    household_id,
    area_id,
    cleaned_on desc,
    cleaned_at desc,
    id desc
  );

alter table public.house_cleaning_areas enable row level security;
alter table public.house_cleaning_rotation_members enable row level security;
alter table public.house_cleaning_history enable row level security;

drop policy if exists house_cleaning_areas_read
  on public.house_cleaning_areas;
create policy house_cleaning_areas_read
on public.house_cleaning_areas for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists house_cleaning_rotation_members_read
  on public.house_cleaning_rotation_members;
create policy house_cleaning_rotation_members_read
on public.house_cleaning_rotation_members for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists house_cleaning_history_read
  on public.house_cleaning_history;
create policy house_cleaning_history_read
on public.house_cleaning_history for select to authenticated
using (household_id = public.current_household_id());

-- Nao ha policies de insert/update/delete. O cliente pode ler apenas a casa
-- atual e deve chamar as RPCs abaixo para qualquer mutacao.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.house_cleaning_areas from anon;
    revoke all on table public.house_cleaning_rotation_members from anon;
    revoke all on table public.house_cleaning_history from anon;
  end if;
end;
$$;

revoke all on table public.house_cleaning_areas from authenticated;
revoke all on table public.house_cleaning_rotation_members from authenticated;
revoke all on table public.house_cleaning_history from authenticated;
grant select on table public.house_cleaning_areas to authenticated;
grant select on table public.house_cleaning_rotation_members to authenticated;
grant select on table public.house_cleaning_history to authenticated;

-- Implementacao interna compartilhada pelo seed e pela RPC publica. A funcao
-- e deliberadamente inacessivel aos papeis da API.
create or replace function public.initialize_house_cleaning_map_for_household(
  target_household_id uuid,
  acting_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  first_active_member_id uuid;
  active_member_count integer;
begin
  if target_household_id is null then
    raise exception 'Informe a casa que sera inicializada.';
  end if;

  -- O bloqueio da casa serializa inicializacao, configuracao e confirmacao,
  -- inclusive antes de uma linha de area existir.
  perform 1
  from public.households household
  where household.id = target_household_id
  for update;

  if not found then
    raise exception 'Casa nao encontrada.';
  end if;

  select count(*)::integer
    into active_member_count
  from public.household_members member
  where member.household_id = target_household_id
    and member.active = true;

  select member.id
    into first_active_member_id
  from public.household_members member
  where member.household_id = target_household_id
    and member.active = true
  order by member.display_order, member.created_at, member.id
  limit 1;

  insert into public.house_cleaning_areas (
    household_id,
    slug,
    name,
    display_order,
    people_per_turn,
    allow_incomplete_last_group,
    current_start_member_id,
    current_since,
    turn_number,
    updated_by,
    updated_at
  )
  select
    target_household_id,
    defaults.slug,
    defaults.name,
    defaults.display_order,
    case when active_member_count >= 2 then 2 else 1 end,
    true,
    first_active_member_id,
    now(),
    1,
    acting_user_id,
    now()
  from (values
    ('sala', 'Sala', 1),
    ('quarto_1', 'Quarto 1', 2),
    ('quarto_2', 'Quarto 2', 3),
    ('suite', 'Suíte', 4),
    ('banheiro_social', 'Banheiro social', 5),
    ('banheiro_suite', 'Banheiro da suíte', 6),
    ('corredor', 'Corredor', 7),
    ('copa', 'Copa', 8),
    ('cozinha', 'Cozinha', 9),
    ('area_servico', 'Área de serviço', 10),
    ('quarto_fundos', 'Quarto dos fundos', 11),
    ('banheiro_servico', 'Banheiro de serviço', 12)
  ) as defaults(slug, name, display_order)
  on conflict (household_id, slug) do nothing;

  -- Preenche apenas areas sem ordem. Assim a inicializacao pode ser repetida
  -- sem sobrescrever personalizacoes feitas pelo administrador.
  insert into public.house_cleaning_rotation_members (
    area_id,
    household_id,
    member_id,
    rotation_order
  )
  select
    area.id,
    area.household_id,
    member.id,
    row_number() over (
      partition by area.id
      order by member.display_order, member.created_at, member.id
    )::integer
  from public.house_cleaning_areas area
  join public.household_members member
    on member.household_id = area.household_id
   and member.active = true
  where area.household_id = target_household_id
    and not exists (
      select 1
      from public.house_cleaning_rotation_members existing
      where existing.area_id = area.id
    );

  -- Tambem recupera uma casa inicializada antes de possuir moradores.
  update public.house_cleaning_areas area
  set current_start_member_id = (
        select rotation.member_id
        from public.house_cleaning_rotation_members rotation
        where rotation.area_id = area.id
        order by rotation.rotation_order
        limit 1
      ),
      people_per_turn = case when active_member_count >= 2 then 2 else 1 end,
      current_since = now(),
      updated_by = acting_user_id,
      updated_at = now()
  where area.household_id = target_household_id
    and area.current_start_member_id is null
    and exists (
      select 1
      from public.house_cleaning_rotation_members rotation
      where rotation.area_id = area.id
    )
    and not exists (
      select 1
      from public.house_cleaning_history history
      where history.area_id = area.id
    );
end;
$$;

revoke all on function public.initialize_house_cleaning_map_for_household(uuid, uuid)
  from public;

-- Cria as areas padrao e a ordem inicial da casa atual. Pode ser executada
-- novamente com seguranca; configuracoes existentes nao sao sobrescritas.
create or replace function public.initialize_house_cleaning_map()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
begin
  select profile.* into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode inicializar o mapa de limpeza.';
  end if;

  perform public.initialize_house_cleaning_map_for_household(
    acting_profile.household_id,
    acting_profile.id
  );
end;
$$;

revoke all on function public.initialize_house_cleaning_map() from public;
grant execute on function public.initialize_house_cleaning_map() to authenticated;

-- Altera a ordem e o tamanho da equipe de um comodo. Cada area pode usar um
-- subconjunto proprio, mas todos os IDs informados devem ser ativos e unicos.
create or replace function public.set_house_cleaning_rotation(
  target_area_slug text,
  ordered_member_ids uuid[],
  target_people_per_turn integer,
  target_allow_incomplete_last_group boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  target_area public.house_cleaning_areas%rowtype;
  normalized_slug text;
  provided_member_count integer;
  distinct_member_count integer;
  previous_ordered_member_ids uuid[];
  resolved_current_member_id uuid;
begin
  select profile.* into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode configurar o rodizio dos comodos.';
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

  select count(*)::integer,
         count(distinct provided.member_id)::integer
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
    and target_area.allow_incomplete_last_group = target_allow_incomplete_last_group then
    return;
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

  -- Toda mudanca material cria uma nova versao do turno. Assim uma aba antiga
  -- nao confirma uma equipe cuja configuracao foi alterada enquanto estava aberta.
  update public.house_cleaning_areas
  set people_per_turn = target_people_per_turn,
      allow_incomplete_last_group = target_allow_incomplete_last_group,
      current_start_member_id = resolved_current_member_id,
      current_since = now(),
      turn_number = turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where id = target_area.id;
end;
$$;

revoke all on function public.set_house_cleaning_rotation(text, uuid[], integer, boolean)
  from public;
grant execute on function public.set_house_cleaning_rotation(text, uuid[], integer, boolean)
  to authenticated;

-- Permite ao administrador escolher manualmente onde o proximo grupo comeca.
create or replace function public.set_house_cleaning_current_member(
  target_area_slug text,
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
  target_area public.house_cleaning_areas%rowtype;
  normalized_slug text;
  normalized_note text;
  target_rotation_order integer;
begin
  select profile.* into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode alterar a pessoa inicial da vez.';
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

  if target_area.current_start_member_id is not distinct from target_member_id then
    return;
  end if;

  update public.house_cleaning_areas
  set current_start_member_id = target_member_id,
      current_since = now(),
      turn_number = turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where id = target_area.id;

  -- O schema ja possui um diario generico de eventos. Ele preserva o motivo
  -- administrativo sem misturar uma troca manual ao historico de limpezas.
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
$$;

revoke all on function public.set_house_cleaning_current_member(text, uuid, text)
  from public;
grant execute on function public.set_house_cleaning_current_member(text, uuid, text)
  to authenticated;

-- Confirma a equipe exibida na tela, salva snapshots e avanca para o proximo
-- grupo na mesma transacao. Repetir uma confirmacao ja concluida devolve o
-- mesmo ID, sem duplicar o historico ou avancar novamente.
create or replace function public.confirm_house_cleaning(
  target_area_slug text,
  expected_turn_number bigint,
  expected_member_ids uuid[],
  cleaning_date date default null,
  cleaning_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  target_area public.house_cleaning_areas%rowtype;
  normalized_slug text;
  normalized_note text;
  resolved_cleaning_date date;
  today_in_sao_paulo date;
  active_member_ids uuid[];
  active_member_names text[];
  active_member_count integer;
  current_start_index integer;
  current_team_size integer;
  current_member_ids uuid[];
  current_member_names text[];
  next_start_index integer;
  next_team_size integer;
  next_member_ids uuid[];
  next_member_names text[];
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
  if coalesce(cardinality(expected_member_ids), 0) = 0
    or cardinality(expected_member_ids) > 2 then
    raise exception 'Informe a equipe exibida para este turno.';
  end if;
  if exists (
    select 1
    from unnest(expected_member_ids) as expected(member_id)
    where expected.member_id is null
  ) or (
    select count(distinct expected.member_id)
    from unnest(expected_member_ids) as expected(member_id)
  ) <> cardinality(expected_member_ids) then
    raise exception 'A equipe esperada contem pessoas invalidas ou repetidas.';
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

  -- Um unico bloqueio por casa elimina corridas entre confirmacao, troca manual
  -- e reconfiguracao sem depender de timeout no navegador.
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

  -- O teste ocorre depois do bloqueio. Se a primeira requisicao terminou e a
  -- resposta se perdeu, uma repeticao encontra exatamente o mesmo turno.
  select history.id, history.member_ids_snapshot
    into existing_history_id, existing_member_ids
  from public.house_cleaning_history history
  where history.area_id = target_area.id
    and history.turn_number = expected_turn_number;

  if existing_history_id is not null then
    if existing_member_ids = expected_member_ids then
      return existing_history_id;
    end if;
    raise exception 'O turno informado ja foi confirmado por outra equipe.';
  end if;

  if target_area.turn_number is distinct from expected_turn_number then
    raise exception 'O turno mudou. Atualize a pagina antes de confirmar a limpeza.';
  end if;

  select
    array_agg(member.id order by rotation.rotation_order),
    array_agg(member.name order by rotation.rotation_order)
  into active_member_ids, active_member_names
  from public.house_cleaning_rotation_members rotation
  join public.household_members member
    on member.household_id = rotation.household_id
   and member.id = rotation.member_id
   and member.active = true
  where rotation.area_id = target_area.id;

  active_member_count := coalesce(cardinality(active_member_ids), 0);
  if active_member_count = 0 then
    raise exception 'Configure ao menos um morador ativo no rodizio deste comodo.';
  end if;
  if target_area.people_per_turn > active_member_count then
    raise exception 'A equipe configurada e maior que a ordem ativa deste comodo.';
  end if;

  current_start_index := array_position(
    active_member_ids,
    target_area.current_start_member_id
  );
  if current_start_index is null then
    raise exception 'A pessoa inicial atual nao esta ativa na ordem deste comodo.';
  end if;
  if target_area.allow_incomplete_last_group
    and ((current_start_index - 1) % target_area.people_per_turn) <> 0 then
    raise exception 'A equipe da vez ficou invalida apos uma mudanca de moradores. Reconfigure o rodizio antes de confirmar.';
  end if;

  current_team_size := case
    when target_area.allow_incomplete_last_group then
      least(
        target_area.people_per_turn,
        active_member_count - current_start_index + 1
      )
    else target_area.people_per_turn
  end;

  select
    array_agg(
      active_member_ids[
        ((current_start_index - 1 + team_offset) % active_member_count) + 1
      ]
      order by team_offset
    ),
    array_agg(
      active_member_names[
        ((current_start_index - 1 + team_offset) % active_member_count) + 1
      ]
      order by team_offset
    )
  into current_member_ids, current_member_names
  from generate_series(0, current_team_size - 1) as offsets(team_offset);

  if current_member_ids is distinct from expected_member_ids then
    raise exception 'A equipe da vez mudou. Atualize a pagina antes de confirmar a limpeza.';
  end if;

  next_start_index := (
    (current_start_index - 1 + current_team_size) % active_member_count
  ) + 1;
  next_team_size := case
    when target_area.allow_incomplete_last_group then
      least(
        target_area.people_per_turn,
        active_member_count - next_start_index + 1
      )
    else target_area.people_per_turn
  end;

  select
    array_agg(
      active_member_ids[
        ((next_start_index - 1 + team_offset) % active_member_count) + 1
      ]
      order by team_offset
    ),
    array_agg(
      active_member_names[
        ((next_start_index - 1 + team_offset) % active_member_count) + 1
      ]
      order by team_offset
    )
  into next_member_ids, next_member_names
  from generate_series(0, next_team_size - 1) as offsets(team_offset);

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
    current_member_ids,
    current_member_names,
    next_member_ids,
    next_member_names,
    acting_profile.id,
    normalized_note
  )
  returning id into new_history_id;

  update public.house_cleaning_areas
  set current_start_member_id = next_member_ids[1],
      current_since = now(),
      turn_number = target_area.turn_number + 1,
      updated_by = acting_profile.id,
      updated_at = now()
  where id = target_area.id;

  return new_history_id;
end;
$$;

revoke all on function public.confirm_house_cleaning(text, bigint, uuid[], date, text)
  from public;
grant execute on function public.confirm_house_cleaning(text, bigint, uuid[], date, text)
  to authenticated;

-- Seed de todas as casas existentes. Cada comodo recebe todos os moradores
-- ativos na ordem visual; casas com duas ou mais pessoas comecam em duplas.
do $$
declare
  target_household record;
begin
  for target_household in
    select household.id
    from public.households household
    order by household.created_at, household.id
  loop
    perform public.initialize_house_cleaning_map_for_household(
      target_household.id,
      null
    );
  end loop;
end;
$$;

comment on table public.house_cleaning_areas is
  'Estado e configuracao do rodizio de limpeza de cada area da casa.';
comment on table public.house_cleaning_rotation_members is
  'Ordem independente dos moradores para cada area do mapa interativo.';
comment on table public.house_cleaning_history is
  'Historico imutavel das equipes que limparam cada area e da equipe seguinte.';
comment on column public.house_cleaning_areas.current_start_member_id is
  'Primeiro morador da equipe atual; os demais sao obtidos pela ordem da area.';
comment on column public.house_cleaning_areas.turn_number is
  'Versao monotona usada para rejeitar confirmacoes de telas desatualizadas.';
comment on column public.house_cleaning_areas.allow_incomplete_last_group is
  'Quando verdadeiro, o fim da lista pode formar uma equipe menor antes de reiniciar.';
comment on function public.initialize_house_cleaning_map() is
  'Inicializa, sem sobrescrever configuracoes existentes, o mapa da casa atual.';
comment on function public.set_house_cleaning_rotation(text, uuid[], integer, boolean) is
  'Configura ordem, tamanho da equipe e regra do ultimo grupo de uma area.';
comment on function public.set_house_cleaning_current_member(text, uuid, text) is
  'Define manualmente o primeiro morador da equipe atual de uma area.';
comment on function public.confirm_house_cleaning(text, bigint, uuid[], date, text) is
  'Confirma idempotentemente uma limpeza e avanca o rodizio da area.';
