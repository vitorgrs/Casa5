-- Regras de limpeza por comodo e registro por quem realmente limpou.
--
-- Esta migration preserva o historico criado pela 032, desativa a antiga
-- area "Copa" (o espaco passa a pertencer integralmente a Cozinha) e mantem
-- o rodizio sequencial do banheiro de servico compativel com a versao
-- anterior.

alter table public.house_cleaning_areas
  add column if not exists cleaning_mode text not null default 'round_robin';

alter table public.house_cleaning_areas
  add column if not exists min_cleaners integer not null default 1;

alter table public.house_cleaning_areas
  add column if not exists max_cleaners integer not null default 2;

alter table public.house_cleaning_areas
  add column if not exists suggested_member_ids uuid[] not null default array[]::uuid[];

-- Primeiro harmoniza os dados da 032; os CHECKs sao recriados logo abaixo.
update public.house_cleaning_areas
set min_cleaners = case
      when allow_incomplete_last_group then 1
      else least(greatest(people_per_turn, 1), 2)
    end,
    max_cleaners = least(greatest(people_per_turn, 1), 2)
where cleaning_mode = 'round_robin'
  and (
    min_cleaners is distinct from case
      when allow_incomplete_last_group then 1
      else least(greatest(people_per_turn, 1), 2)
    end
    or max_cleaners is distinct from least(greatest(people_per_turn, 1), 2)
  );

alter table public.house_cleaning_areas
  drop constraint if exists house_cleaning_areas_cleaning_mode_check;
alter table public.house_cleaning_areas
  add constraint house_cleaning_areas_cleaning_mode_check check (
    cleaning_mode in ('fixed', 'flexible', 'balanced', 'round_robin')
  );

alter table public.house_cleaning_areas
  drop constraint if exists house_cleaning_areas_cleaner_limits_check;
alter table public.house_cleaning_areas
  add constraint house_cleaning_areas_cleaner_limits_check check (
    min_cleaners between 1 and 2
    and max_cleaners between min_cleaners and 2
  );

alter table public.house_cleaning_areas
  drop constraint if exists house_cleaning_areas_suggested_team_size_check;
alter table public.house_cleaning_areas
  add constraint house_cleaning_areas_suggested_team_size_check check (
    cardinality(suggested_member_ids) between 0 and max_cleaners
  );

-- Areas flexiveis nao possuem necessariamente uma "proxima equipe". O
-- snapshot vazio e intencional e preserva a verdade historica sem inventar
-- uma pessoa da vez.
alter table public.house_cleaning_history
  drop constraint if exists house_cleaning_history_next_team_size;
alter table public.house_cleaning_history
  add constraint house_cleaning_history_next_team_size check (
    cardinality(next_member_ids_snapshot) between 0 and 2
    and cardinality(next_member_names_snapshot) = cardinality(next_member_ids_snapshot)
  );

-- Calcula uma equipe sequencial usando a ordem configurada na 032. A funcao
-- e interna: as RPCs publicas abaixo sao as unicas entradas de escrita.
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
  member_count integer;
  start_index integer;
  resolved_team_size integer;
  result_member_ids uuid[];
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

  start_index := array_position(ordered_member_ids, target_start_member_id);
  if start_index is null then
    start_index := 1;
  end if;

  resolved_team_size := least(greatest(coalesce(target_team_size, 1), 1), member_count);
  if coalesce(target_allow_incomplete, false) then
    resolved_team_size := least(
      resolved_team_size,
      member_count - start_index + 1
    );
  end if;

  select coalesce(
    array_agg(
      ordered_member_ids[
        ((start_index - 1 + team_offset) % member_count) + 1
      ]
      order by team_offset
    ),
    array[]::uuid[]
  )
    into result_member_ids
  from generate_series(0, resolved_team_size - 1) as offsets(team_offset);

  return result_member_ids;
end;
$$;

revoke all on function public.house_cleaning_round_robin_team(
  uuid,
  uuid,
  integer,
  boolean
) from public;

-- Sugere quem participou menos naquele comodo. Em caso de empate, prioriza
-- quem limpou ha mais tempo (ou nunca limpou) e depois a ordem configurada.
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
    group by rotation.member_id, rotation.rotation_order
  ) ranked
  where ranked.pick_order <= greatest(coalesce(target_team_size, 1), 1);
$$;

revoke all on function public.house_cleaning_balanced_team(uuid, integer)
  from public;

-- O inicializador deixa de criar Copa. Para a Casa Cinco, areas novas ja
-- nascem com o conjunto correto de moradores e com a regra solicitada; nas
-- demais casas continua valendo o rodizio sequencial da 032.
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
  casa_cinco_id constant uuid := '11111111-1111-1111-1111-111111111111'::uuid;
  vitor_id constant uuid := '11111111-1111-1111-1111-111111111101'::uuid;
  belo_id constant uuid := '11111111-1111-1111-1111-111111111102'::uuid;
  savio_id constant uuid := '11111111-1111-1111-1111-111111111103'::uuid;
  patrick_id constant uuid := '11111111-1111-1111-1111-111111111104'::uuid;
  william_id constant uuid := '11111111-1111-1111-1111-111111111105'::uuid;
  first_active_member_id uuid;
  active_member_count integer;
begin
  if target_household_id is null then
    raise exception 'Informe a casa que sera inicializada.';
  end if;

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
    cleaning_mode,
    min_cleaners,
    max_cleaners,
    suggested_member_ids,
    updated_by,
    updated_at
  )
  select
    target_household_id,
    defaults.slug,
    defaults.name,
    defaults.display_order,
    case
      when target_household_id = casa_cinco_id then defaults.max_cleaners
      when active_member_count >= 2 then 2
      else 1
    end,
    true,
    case
      when target_household_id = casa_cinco_id
       and defaults.cleaning_mode = 'flexible' then null
      when target_household_id = casa_cinco_id
       and defaults.slug = 'quarto_1' then belo_id
      when target_household_id = casa_cinco_id
       and defaults.slug in ('suite', 'banheiro_suite') then savio_id
      else first_active_member_id
    end,
    now(),
    1,
    case
      when target_household_id = casa_cinco_id then defaults.cleaning_mode
      else 'round_robin'
    end,
    case
      when target_household_id = casa_cinco_id then defaults.min_cleaners
      else 1
    end,
    case
      when target_household_id = casa_cinco_id then defaults.max_cleaners
      when active_member_count >= 2 then 2
      else 1
    end,
    array[]::uuid[],
    acting_user_id,
    now()
  from (values
    ('sala', 'Sala', 1, 'balanced', 2, 2),
    ('quarto_1', 'Quarto 1', 2, 'fixed', 1, 1),
    ('quarto_2', 'Quarto 2', 3, 'flexible', 1, 2),
    ('suite', 'Quarto da suíte', 4, 'flexible', 1, 2),
    ('banheiro_social', 'Banheiro social', 5, 'balanced', 1, 1),
    ('banheiro_suite', 'Banheiro da suíte', 6, 'balanced', 1, 1),
    ('corredor', 'Corredor', 7, 'balanced', 2, 2),
    ('cozinha', 'Cozinha', 8, 'balanced', 2, 2),
    ('area_servico', 'Área de serviço', 9, 'balanced', 2, 2),
    ('quarto_fundos', 'Quarto de serviço', 10, 'balanced', 2, 2),
    ('banheiro_servico', 'Banheiro de serviço', 11, 'round_robin', 1, 2)
  ) as defaults(
    slug,
    name,
    display_order,
    cleaning_mode,
    min_cleaners,
    max_cleaners
  )
  on conflict (household_id, slug) do nothing;

  -- Uma Copa antiga nunca volta a aparecer, inclusive se o inicializador for
  -- chamado novamente por uma instalacao que ja passou pela 032.
  update public.house_cleaning_areas
  set active = false,
      current_start_member_id = null,
      suggested_member_ids = array[]::uuid[],
      updated_by = acting_user_id,
      updated_at = now()
  where household_id = target_household_id
    and slug = 'copa'
    and (
      active = true
      or current_start_member_id is not null
      or cardinality(suggested_member_ids) <> 0
    );

  -- Preenche somente areas ainda sem lista. Na Casa Cinco, as listas de
  -- quartos e banheiros sao subconjuntos; areas comuns usam todos os ativos.
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
    and area.active = true
    and not exists (
      select 1
      from public.house_cleaning_rotation_members existing
      where existing.area_id = area.id
    )
    and (
      target_household_id <> casa_cinco_id
      or area.slug in (
        'sala',
        'corredor',
        'cozinha',
        'area_servico',
        'quarto_fundos',
        'banheiro_servico'
      )
      or (area.slug = 'quarto_1' and member.id = belo_id)
      or (area.slug = 'quarto_2' and member.id in (vitor_id, patrick_id))
      or (area.slug = 'suite' and member.id in (savio_id, william_id))
      or (
        area.slug = 'banheiro_social'
        and member.id in (belo_id, patrick_id, vitor_id)
      )
      or (
        area.slug = 'banheiro_suite'
        and member.id in (savio_id, william_id)
      )
    );

  update public.house_cleaning_areas area
  set current_start_member_id = case area.cleaning_mode
        when 'flexible' then null
        when 'fixed' then (
          select rotation.member_id
          from public.house_cleaning_rotation_members rotation
          join public.household_members member
            on member.household_id = rotation.household_id
           and member.id = rotation.member_id
           and member.active = true
          where rotation.area_id = area.id
          order by rotation.rotation_order
          limit 1
        )
        when 'balanced' then (
          public.house_cleaning_balanced_team(area.id, area.max_cleaners)
        )[1]
        else coalesce(
          area.current_start_member_id,
          (
            select rotation.member_id
            from public.house_cleaning_rotation_members rotation
            join public.household_members member
              on member.household_id = rotation.household_id
             and member.id = rotation.member_id
             and member.active = true
            where rotation.area_id = area.id
            order by rotation.rotation_order
            limit 1
          )
        )
      end,
      suggested_member_ids = case area.cleaning_mode
        when 'fixed' then (
          select coalesce(
            array_agg(rotation.member_id order by rotation.rotation_order),
            array[]::uuid[]
          )
          from public.house_cleaning_rotation_members rotation
          join public.household_members member
            on member.household_id = rotation.household_id
           and member.id = rotation.member_id
           and member.active = true
          where rotation.area_id = area.id
        )
        when 'balanced' then public.house_cleaning_balanced_team(
          area.id,
          area.max_cleaners
        )
        when 'round_robin' then public.house_cleaning_round_robin_team(
          area.id,
          coalesce(
            area.current_start_member_id,
            (
              select rotation.member_id
              from public.house_cleaning_rotation_members rotation
              where rotation.area_id = area.id
              order by rotation.rotation_order
              limit 1
            )
          ),
          area.people_per_turn,
          area.allow_incomplete_last_group
        )
        else array[]::uuid[]
      end,
      current_since = now(),
      updated_by = acting_user_id,
      updated_at = now()
  where area.household_id = target_household_id
    and area.active = true
    and not exists (
      select 1
      from public.house_cleaning_history history
      where history.area_id = area.id
    )
    and exists (
      select 1
      from public.house_cleaning_rotation_members rotation
      where rotation.area_id = area.id
    )
    and (
      (
        area.cleaning_mode = 'flexible'
        and (
          area.current_start_member_id is not null
          or cardinality(area.suggested_member_ids) <> 0
        )
      )
      or (
        area.cleaning_mode <> 'flexible'
        and (
          area.current_start_member_id is null
          or cardinality(area.suggested_member_ids) = 0
        )
      )
    );
end;
$$;

revoke all on function public.initialize_house_cleaning_map_for_household(uuid, uuid)
  from public;

-- A configuracao generica continua disponivel apenas para areas que realmente
-- usam fila sequencial. Isso impede que um cliente antigo desmonte, por
-- exemplo, a responsabilidade fixa do Quarto 1.
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
  resolved_suggestion uuid[];
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
$$;

revoke all on function public.set_house_cleaning_rotation(
  text,
  uuid[],
  integer,
  boolean
) from public;
grant execute on function public.set_house_cleaning_rotation(
  text,
  uuid[],
  integer,
  boolean
) to authenticated;

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
  resolved_suggestion uuid[];
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
$$;

revoke all on function public.set_house_cleaning_current_member(text, uuid, text)
  from public;
grant execute on function public.set_house_cleaning_current_member(text, uuid, text)
  to authenticated;

-- Registra os moradores que realmente limparam. Para fixed, a equipe e fixa;
-- flexible aceita qualquer subconjunto permitido; balanced aceita a equipe
-- real e calcula a proxima sugestao por justica; round_robin exige a equipe
-- da vez e avanca exatamente como na 032.
create or replace function public.register_house_cleaning(
  target_area_slug text,
  expected_turn_number bigint,
  cleaner_member_ids uuid[],
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

  if acting_profile.role <> 'admin'::public.user_role
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
$$;

revoke all on function public.register_house_cleaning(
  text,
  bigint,
  uuid[],
  date,
  text
) from public;
grant execute on function public.register_house_cleaning(
  text,
  bigint,
  uuid[],
  date,
  text
) to authenticated;

-- Mantem clientes ainda carregados com a RPC antiga funcionando, mas aplica
-- as novas regras e autorizacoes no mesmo ponto central.
create or replace function public.confirm_house_cleaning(
  target_area_slug text,
  expected_turn_number bigint,
  expected_member_ids uuid[],
  cleaning_date date default null,
  cleaning_note text default null
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.register_house_cleaning(
    target_area_slug,
    expected_turn_number,
    expected_member_ids,
    cleaning_date,
    cleaning_note
  );
$$;

revoke all on function public.confirm_house_cleaning(
  text,
  bigint,
  uuid[],
  date,
  text
) from public;
grant execute on function public.confirm_house_cleaning(
  text,
  bigint,
  uuid[],
  date,
  text
) to authenticated;

-- Migra os registros antigos de Copa para Cozinha sem colidir com os turnos
-- ja existentes. Os numeros continuam unicos e monotonicamente crescentes.
with copa_history as (
  select
    history.id,
    cozinha.id as cozinha_area_id,
    coalesce(kitchen_max.max_turn_number, 0)
      + row_number() over (
          partition by copa.household_id
          order by history.cleaned_on, history.cleaned_at, history.id
        ) as new_turn_number
  from public.house_cleaning_history history
  join public.house_cleaning_areas copa
    on copa.id = history.area_id
   and copa.slug = 'copa'
  join public.house_cleaning_areas cozinha
    on cozinha.household_id = copa.household_id
   and cozinha.slug = 'cozinha'
  left join lateral (
    select max(existing.turn_number) as max_turn_number
    from public.house_cleaning_history existing
    where existing.area_id = cozinha.id
  ) kitchen_max on true
)
update public.house_cleaning_history history
set area_id = copa_history.cozinha_area_id,
    turn_number = copa_history.new_turn_number
from copa_history
where history.id = copa_history.id;

-- A cozinha avanca para alem do maior snapshot importado, invalidando com
-- seguranca qualquer formulario antigo aberto antes da unificacao.
update public.house_cleaning_areas cozinha
set turn_number = greatest(
      cozinha.turn_number,
      coalesce(
        (
          select max(history.turn_number) + 1
          from public.house_cleaning_history history
          where history.area_id = cozinha.id
        ),
        cozinha.turn_number
      )
    ),
    current_since = case
      when exists (
        select 1
        from public.house_cleaning_history history
        where history.area_id = cozinha.id
      ) then now()
      else cozinha.current_since
    end,
    updated_at = now()
where cozinha.slug = 'cozinha';

delete from public.house_cleaning_rotation_members rotation
using public.house_cleaning_areas copa
where copa.id = rotation.area_id
  and copa.slug = 'copa';

update public.house_cleaning_areas
set active = false,
    current_start_member_id = null,
    suggested_member_ids = array[]::uuid[],
    updated_at = now()
where slug = 'copa'
  and (
    active = true
    or current_start_member_id is not null
    or cardinality(suggested_member_ids) <> 0
  );

update public.house_cleaning_areas
set name = case slug
      when 'suite' then 'Quarto da suíte'
      when 'banheiro_suite' then 'Banheiro da suíte'
      when 'area_servico' then 'Área de serviço'
      when 'quarto_fundos' then 'Quarto de serviço'
      when 'banheiro_servico' then 'Banheiro de serviço'
      else name
    end,
    display_order = case slug
      when 'sala' then 1
      when 'quarto_1' then 2
      when 'quarto_2' then 3
      when 'suite' then 4
      when 'banheiro_social' then 5
      when 'banheiro_suite' then 6
      when 'corredor' then 7
      when 'cozinha' then 8
      when 'area_servico' then 9
      when 'quarto_fundos' then 10
      when 'banheiro_servico' then 11
      else display_order
    end,
    updated_at = now()
where slug <> 'copa';

-- Aplica as regras exatas da Casa Cinco aos dados que ja foram criados pela
-- 032. A comparacao evita incrementar o turno em uma reaplicacao identica.
do $$
declare
  casa_cinco_id constant uuid := '11111111-1111-1111-1111-111111111111'::uuid;
  vitor_id constant uuid := '11111111-1111-1111-1111-111111111101'::uuid;
  belo_id constant uuid := '11111111-1111-1111-1111-111111111102'::uuid;
  savio_id constant uuid := '11111111-1111-1111-1111-111111111103'::uuid;
  patrick_id constant uuid := '11111111-1111-1111-1111-111111111104'::uuid;
  william_id constant uuid := '11111111-1111-1111-1111-111111111105'::uuid;
  target_rule record;
  target_area public.house_cleaning_areas%rowtype;
  existing_member_ids uuid[];
  valid_member_ids uuid[];
  next_suggestion uuid[];
  resolved_current_member_id uuid;
  material_change boolean;
begin
  if not exists (
    select 1 from public.households where id = casa_cinco_id
  ) then
    return;
  end if;

  for target_rule in
    select *
    from (values
      ('sala', 'balanced', 2, 2, array[vitor_id, belo_id, savio_id, patrick_id, william_id]::uuid[]),
      ('quarto_1', 'fixed', 1, 1, array[belo_id]::uuid[]),
      ('quarto_2', 'flexible', 1, 2, array[vitor_id, patrick_id]::uuid[]),
      ('suite', 'flexible', 1, 2, array[savio_id, william_id]::uuid[]),
      ('banheiro_social', 'balanced', 1, 1, array[vitor_id, belo_id, patrick_id]::uuid[]),
      ('banheiro_suite', 'balanced', 1, 1, array[savio_id, william_id]::uuid[]),
      ('corredor', 'balanced', 2, 2, array[vitor_id, belo_id, savio_id, patrick_id, william_id]::uuid[]),
      ('cozinha', 'balanced', 2, 2, array[vitor_id, belo_id, savio_id, patrick_id, william_id]::uuid[]),
      ('area_servico', 'balanced', 2, 2, array[vitor_id, belo_id, savio_id, patrick_id, william_id]::uuid[]),
      ('quarto_fundos', 'balanced', 2, 2, array[vitor_id, belo_id, savio_id, patrick_id, william_id]::uuid[]),
      ('banheiro_servico', 'round_robin', 1, 2, array[vitor_id, belo_id, savio_id, patrick_id, william_id]::uuid[])
    ) as rules(slug, cleaning_mode, min_cleaners, max_cleaners, member_ids)
  loop
    select area.* into target_area
    from public.house_cleaning_areas area
    where area.household_id = casa_cinco_id
      and area.slug = target_rule.slug
      and area.active = true;

    if target_area.id is null then
      continue;
    end if;

    select coalesce(
      array_agg(requested.member_id order by requested.position),
      array[]::uuid[]
    )
      into valid_member_ids
    from unnest(target_rule.member_ids) with ordinality
      as requested(member_id, position)
    join public.household_members member
      on member.household_id = casa_cinco_id
     and member.id = requested.member_id
     and member.active = true;

    if cardinality(valid_member_ids) < target_rule.min_cleaners then
      raise exception 'Faltam moradores ativos para configurar o comodo %.', target_rule.slug;
    end if;

    select coalesce(
      array_agg(rotation.member_id order by rotation.rotation_order),
      array[]::uuid[]
    )
      into existing_member_ids
    from public.house_cleaning_rotation_members rotation
    where rotation.area_id = target_area.id;

    material_change := existing_member_ids is distinct from valid_member_ids
      or target_area.cleaning_mode is distinct from target_rule.cleaning_mode
      or target_area.min_cleaners is distinct from target_rule.min_cleaners
      or target_area.max_cleaners is distinct from target_rule.max_cleaners
      or target_area.people_per_turn is distinct from target_rule.max_cleaners;

    if existing_member_ids is distinct from valid_member_ids then
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
        casa_cinco_id,
        requested.member_id,
        requested.position::integer
      from unnest(valid_member_ids) with ordinality
        as requested(member_id, position);
    end if;

    if target_rule.cleaning_mode = 'fixed' then
      next_suggestion := valid_member_ids;
      resolved_current_member_id := valid_member_ids[1];
    elsif target_rule.cleaning_mode = 'flexible' then
      next_suggestion := array[]::uuid[];
      resolved_current_member_id := null;
    elsif target_rule.cleaning_mode = 'balanced' then
      next_suggestion := public.house_cleaning_balanced_team(
        target_area.id,
        target_rule.max_cleaners
      );
      resolved_current_member_id := next_suggestion[1];
    else
      resolved_current_member_id := case
        when target_area.current_start_member_id = any(valid_member_ids)
          then target_area.current_start_member_id
        else valid_member_ids[1]
      end;
      next_suggestion := public.house_cleaning_round_robin_team(
        target_area.id,
        resolved_current_member_id,
        target_rule.max_cleaners,
        target_area.allow_incomplete_last_group
      );
    end if;

    material_change := material_change
      or target_area.current_start_member_id is distinct from resolved_current_member_id
      or target_area.suggested_member_ids is distinct from next_suggestion;

    update public.house_cleaning_areas
    set cleaning_mode = target_rule.cleaning_mode,
        min_cleaners = target_rule.min_cleaners,
        max_cleaners = target_rule.max_cleaners,
        people_per_turn = target_rule.max_cleaners,
        current_start_member_id = resolved_current_member_id,
        suggested_member_ids = next_suggestion,
        current_since = case when material_change then now() else current_since end,
        turn_number = case when material_change then turn_number + 1 else turn_number end,
        updated_at = case when material_change then now() else updated_at end
    where id = target_area.id;
  end loop;
end;
$$;

-- Garante que casas existentes recebam qualquer area nova e que nenhuma Copa
-- permaneça ativa. O inicializador nao sobrescreve configuracoes ja presentes.
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

comment on column public.house_cleaning_areas.cleaning_mode is
  'Regra do comodo: fixed, flexible, balanced ou round_robin.';
comment on column public.house_cleaning_areas.min_cleaners is
  'Quantidade minima de moradores aceita em um registro de limpeza.';
comment on column public.house_cleaning_areas.max_cleaners is
  'Quantidade maxima de moradores aceita em um registro de limpeza.';
comment on column public.house_cleaning_areas.suggested_member_ids is
  'Equipe sugerida para o turno atual; pode ficar vazia no modo flexible.';
comment on function public.register_house_cleaning(text, bigint, uuid[], date, text) is
  'Registra idempotentemente quem realmente limpou e calcula a proxima sugestao.';
