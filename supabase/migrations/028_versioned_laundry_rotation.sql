-- Versões imutáveis do rodízio da lavanderia.
--
-- Cada alteração passa a valer em `effective_from`. As versões anteriores não
-- são atualizadas nem apagadas, portanto o calendário já transcorrido continua
-- reproduzível mesmo quando ordem, intervalo ou tamanho dos grupos mudarem.
-- Rode depois da 027_secure_expense_share_updates.sql.

alter table public.laundry_rotation_settings
  add column if not exists effective_from date,
  add column if not exists people_per_day integer not null default 2,
  add column if not exists allow_incomplete_last_group boolean not null default true;

update public.laundry_rotation_settings
set effective_from = coalesce(
  effective_from,
  (now() at time zone 'America/Sao_Paulo')::date
);

alter table public.laundry_rotation_settings
  alter column effective_from set default ((now() at time zone 'America/Sao_Paulo')::date),
  alter column effective_from set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'laundry_rotation_settings_people_per_day_check'
      and conrelid = 'public.laundry_rotation_settings'::regclass
  ) then
    alter table public.laundry_rotation_settings
      add constraint laundry_rotation_settings_people_per_day_check
      check (people_per_day between 1 and 50);
  end if;
end;
$$;

create table if not exists public.laundry_rotation_versions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  effective_from date not null,
  anchor_date date not null,
  -- Sem FK propositalmente: os snapshots de membros preservam o histórico até
  -- se um cadastro de morador for removido no futuro.
  anchor_member_id uuid not null,
  gap_days integer not null check (gap_days between 0 and 30),
  people_per_day integer not null default 2 check (people_per_day between 1 and 50),
  allow_incomplete_last_group boolean not null default true,
  seed_kind text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (household_id, effective_from),
  unique (id, household_id)
);

alter table public.laundry_rotation_versions
  add column if not exists seed_kind text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'laundry_rotation_versions_seed_kind_check'
      and conrelid = 'public.laundry_rotation_versions'::regclass
  ) then
    alter table public.laundry_rotation_versions
      add constraint laundry_rotation_versions_seed_kind_check
      check (seed_kind is null or seed_kind in ('legacy_history', 'group_cutover'));
  end if;
end;
$$;

create unique index if not exists laundry_rotation_versions_seed_kind_unique
  on public.laundry_rotation_versions(household_id, seed_kind)
  where seed_kind is not null;

create table if not exists public.laundry_rotation_version_members (
  version_id uuid not null,
  household_id uuid not null references public.households(id) on delete cascade,
  -- O UUID e estes dados são snapshots. Não há cascade a partir do cadastro
  -- vivo do morador, pois isso apagaria a composição de escalas antigas.
  member_id uuid not null,
  member_name text not null,
  member_initials text not null,
  member_color_key text not null,
  rotation_order integer not null check (rotation_order > 0),
  created_at timestamptz not null default now(),
  primary key (version_id, member_id),
  unique (version_id, rotation_order),
  foreign key (version_id, household_id)
    references public.laundry_rotation_versions(id, household_id) on delete cascade
);

-- Versões preliminares da migration impunham limites que não existem em
-- household_members. Removê-los também torna uma reaplicação segura.
alter table public.laundry_rotation_version_members
  drop constraint if exists laundry_rotation_version_members_member_name_check,
  drop constraint if exists laundry_rotation_version_members_member_initials_check,
  drop constraint if exists laundry_rotation_version_members_member_color_key_check;

-- Guarda permanente por casa. Sem ela, reaplicar a migration em outro dia
-- poderia interpretar a configuração vigente como um novo legado e criar um
-- segundo corte automático.
create table if not exists public.laundry_rotation_versioning_state (
  household_id uuid primary key references public.households(id) on delete cascade,
  -- IDs de auditoria, sem FK: a versão do próprio dia pode ser legitimamente
  -- substituída pelo administrador sem remover a guarda de inicialização.
  legacy_version_id uuid not null,
  cutover_version_id uuid not null,
  initialized_at timestamptz not null default now(),
  check (legacy_version_id <> cutover_version_id)
);

alter table public.laundry_rotation_versioning_state
  drop constraint if exists laundry_rotation_versioning_state_legacy_version_id_fkey,
  drop constraint if exists laundry_rotation_versioning_state_cutover_version_id_fkey;

create index if not exists laundry_rotation_versions_period_idx
  on public.laundry_rotation_versions(household_id, effective_from desc);

create index if not exists laundry_rotation_version_members_order_idx
  on public.laundry_rotation_version_members(version_id, rotation_order);

alter table public.laundry_rotation_versions enable row level security;
alter table public.laundry_rotation_version_members enable row level security;
alter table public.laundry_rotation_versioning_state enable row level security;

drop policy if exists laundry_rotation_versions_read
  on public.laundry_rotation_versions;
create policy laundry_rotation_versions_read
on public.laundry_rotation_versions
for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists laundry_rotation_version_members_read
  on public.laundry_rotation_version_members;
create policy laundry_rotation_version_members_read
on public.laundry_rotation_version_members
for select to authenticated
using (household_id = public.current_household_id());

-- Uma pessoa autenticada pode somente consultar o histórico. Nem mesmo o
-- administrador altera as tabelas diretamente: toda escrita passa pelo RPC,
-- que impede datas anteriores a hoje.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.laundry_rotation_versions from anon;
    revoke all on table public.laundry_rotation_version_members from anon;
    revoke all on table public.laundry_rotation_versioning_state from anon;
    revoke all on table public.laundry_rotation_settings from anon;
    revoke all on table public.laundry_rotation_members from anon;
  end if;
end;
$$;
revoke all on table public.laundry_rotation_versions from authenticated;
revoke all on table public.laundry_rotation_version_members from authenticated;
revoke all on table public.laundry_rotation_versioning_state from authenticated;
revoke all on table public.laundry_rotation_settings from authenticated;
revoke all on table public.laundry_rotation_members from authenticated;
grant select on table public.laundry_rotation_versions to authenticated;
grant select on table public.laundry_rotation_version_members to authenticated;
grant select on table public.laundry_rotation_settings to authenticated;
grant select on table public.laundry_rotation_members to authenticated;

-- Os registros legados continuam como espelho da versão vigente durante a
-- transição do frontend, mas deixam de aceitar escrita direta.
drop policy if exists laundry_rotation_settings_admin_all
  on public.laundry_rotation_settings;
drop policy if exists laundry_rotation_members_admin_all
  on public.laundry_rotation_members;

-- Primeiro materializa a configuração antiga com uma pessoa por data. Sua
-- vigência termina ontem, preservando tudo que já apareceu no calendário.
insert into public.laundry_rotation_versions (
  household_id,
  effective_from,
  anchor_date,
  anchor_member_id,
  gap_days,
  people_per_day,
  allow_incomplete_last_group,
  seed_kind,
  created_by,
  created_at
)
select
  settings.household_id,
  least(
    settings.anchor_date,
    (now() at time zone 'America/Sao_Paulo')::date - 1
  ),
  settings.anchor_date,
  settings.anchor_member_id,
  settings.gap_days,
  1,
  true,
  'legacy_history',
  settings.updated_by,
  settings.updated_at
from public.laundry_rotation_settings settings
where exists (
  select 1
  from public.laundry_rotation_members member
  where member.household_id = settings.household_id
)
and not exists (
  select 1
  from public.laundry_rotation_versioning_state state
  where state.household_id = settings.household_id
)
on conflict do nothing;

-- Calcula a próxima data da escala antiga. A nova configuração começa hoje,
-- mas mantém a próxima lavagem que já estava prevista e inclui esse morador no
-- primeiro grupo de duas pessoas.
with local_clock as (
  select (now() at time zone 'America/Sao_Paulo')::date as today
),
ordered_members as (
  select
    member.household_id,
    member.member_id,
    row_number() over (
      partition by member.household_id order by member.rotation_order
    )::integer as member_position,
    count(*) over (partition by member.household_id)::integer as member_count
  from public.laundry_rotation_members member
),
base as (
  select
    settings.*,
    clock.today,
    coalesce(latest_reset.wash_date, settings.anchor_date) as legacy_anchor_date,
    coalesce(latest_reset.member_id, settings.anchor_member_id) as legacy_anchor_member_id,
    anchor.member_position as anchor_position,
    anchor.member_count,
    case
      when coalesce(latest_reset.wash_date, settings.anchor_date) >= clock.today then 0
      else (
        (
          (
            clock.today
            - coalesce(latest_reset.wash_date, settings.anchor_date)
          )
          + settings.gap_days
        )
        / (settings.gap_days + 1)
      )::integer
    end as turns_until_next
  from public.laundry_rotation_settings settings
  cross join local_clock clock
  left join lateral (
    select override.wash_date, override.member_id
    from public.laundry_rotation_overrides override
    where override.household_id = settings.household_id
      and override.resets_rotation = true
      and override.wash_date >= settings.anchor_date
      -- Um reset de hoje substitui visualmente a lavagem do dia, mas já deve
      -- orientar os grupos regulares seguintes.
      and override.wash_date <= clock.today
      and (
        settings.updated_at is null
        or override.created_at is null
        or override.created_at >= settings.updated_at
      )
    order by override.wash_date desc, override.created_at desc, override.id desc
    limit 1
  ) latest_reset on true
  join ordered_members anchor
    on anchor.household_id = settings.household_id
   and anchor.member_id = coalesce(latest_reset.member_id, settings.anchor_member_id)
  where not exists (
    select 1
    from public.laundry_rotation_versioning_state state
    where state.household_id = settings.household_id
  )
),
next_assignment as (
  select
    base.*,
    least(2, base.member_count) as target_people_per_day,
    base.legacy_anchor_date + base.turns_until_next * (base.gap_days + 1) as next_wash_date,
    (
      ((base.anchor_position - 1 + base.turns_until_next) % base.member_count)
      + 1
    )::integer as next_member_position
  from base
),
-- Para grupos fixos de duas pessoas, a âncora precisa ser o primeiro membro
-- do bloco que contém a pessoa originalmente escalada.
new_anchor as (
  select
    next_assignment.*,
    (((
      (next_assignment.next_member_position - 1)
      / next_assignment.target_people_per_day
    ) * next_assignment.target_people_per_day) + 1)::integer
      as group_anchor_position
  from next_assignment
)
insert into public.laundry_rotation_versions (
  household_id,
  effective_from,
  anchor_date,
  anchor_member_id,
  gap_days,
  people_per_day,
  allow_incomplete_last_group,
  seed_kind,
  created_by,
  created_at
)
select
  config.household_id,
  config.today,
  config.next_wash_date,
  member.member_id,
  config.gap_days,
  config.target_people_per_day,
  true,
  'group_cutover',
  config.updated_by,
  now()
from new_anchor config
join ordered_members member
  on member.household_id = config.household_id
 and member.member_position = config.group_anchor_position
on conflict do nothing;

-- Copia nome, iniciais e cor somente para versões criadas por este seed e que
-- ainda estejam inteiramente sem snapshots. Nunca completa uma versão parcial
-- com o cadastro ou a ordem atuais, pois isso misturaria épocas diferentes.
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
  version.id,
  version.household_id,
  rotation.member_id,
  member.name,
  member.initials,
  member.color_key,
  rotation.rotation_order
from public.laundry_rotation_versions version
join public.laundry_rotation_members rotation
  on rotation.household_id = version.household_id
join public.household_members member
  on member.household_id = rotation.household_id
 and member.id = rotation.member_id
where version.seed_kind in ('legacy_history', 'group_cutover')
  and not exists (
    select 1
    from public.laundry_rotation_versioning_state state
    where state.household_id = version.household_id
  )
  and not exists (
    select 1
    from public.laundry_rotation_version_members existing_snapshot
    where existing_snapshot.version_id = version.id
  )
on conflict (version_id, member_id) do nothing;

-- Marca a casa somente depois de as duas versões e todos os respectivos
-- snapshots existirem. Se uma execução for interrompida antes disso, a próxima
-- pode terminar o seed; após a marcação, nem uma reaplicação em outro dia gera
-- novo cutover.
insert into public.laundry_rotation_versioning_state (
  household_id,
  legacy_version_id,
  cutover_version_id
)
select
  settings.household_id,
  legacy.id,
  cutover.id
from public.laundry_rotation_settings settings
join public.laundry_rotation_versions legacy
  on legacy.household_id = settings.household_id
 and legacy.seed_kind = 'legacy_history'
join public.laundry_rotation_versions cutover
  on cutover.household_id = settings.household_id
 and cutover.seed_kind = 'group_cutover'
where not exists (
  select 1
  from public.laundry_rotation_versioning_state state
  where state.household_id = settings.household_id
)
and (
  select count(*)
  from public.laundry_rotation_version_members snapshot
  where snapshot.version_id = legacy.id
) = (
  select count(*)
  from public.laundry_rotation_members rotation
  where rotation.household_id = settings.household_id
)
and (
  select count(*)
  from public.laundry_rotation_version_members snapshot
  where snapshot.version_id = cutover.id
) = (
  select count(*)
  from public.laundry_rotation_members rotation
  where rotation.household_id = settings.household_id
)
and exists (
  select 1
  from public.laundry_rotation_members rotation
  where rotation.household_id = settings.household_id
)
on conflict (household_id) do nothing;

-- Mantém as tabelas antigas refletindo a versão atual para permitir uma
-- implantação sem indisponibilidade entre migration e frontend.
update public.laundry_rotation_settings settings
set effective_from = version.effective_from,
    anchor_date = version.anchor_date,
    anchor_member_id = version.anchor_member_id,
    gap_days = version.gap_days,
    people_per_day = version.people_per_day,
    allow_incomplete_last_group = version.allow_incomplete_last_group,
    updated_at = version.created_at
from public.laundry_rotation_versions version
where version.household_id = settings.household_id
  and version.effective_from = (now() at time zone 'America/Sao_Paulo')::date;

create or replace function public.set_laundry_rotation(
  rotation_anchor_date date,
  rotation_anchor_member_id uuid,
  rotation_gap_days integer,
  rotation_people_per_day integer,
  rotation_allow_incomplete_last_group boolean,
  ordered_member_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

  if acting_profile.id is null or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode configurar a lavanderia.';
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
$$;

revoke all on function public.set_laundry_rotation(
  date, uuid, integer, integer, boolean, uuid[]
) from public;
grant execute on function public.set_laundry_rotation(
  date, uuid, integer, integer, boolean, uuid[]
) to authenticated;

-- Compatibilidade com clientes implantados antes desta migration. O formato
-- antigo mantém a quantidade e a política de grupos vigentes e cria uma nova
-- versão a partir de hoje, em vez de reescrever a configuração histórica.
create or replace function public.set_laundry_rotation(
  rotation_anchor_date date,
  rotation_anchor_member_id uuid,
  rotation_gap_days integer,
  ordered_member_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_household_id uuid;
  current_people_per_day integer := 2;
  normalized_people_per_day integer := 1;
  current_allow_incomplete boolean := true;
  anchor_position integer;
  normalized_anchor_member_id uuid;
begin
  select household_id into acting_household_id
  from public.profiles
  where id = auth.uid()
    and status = 'active';

  select settings.people_per_day, settings.allow_incomplete_last_group
    into current_people_per_day, current_allow_incomplete
  from public.laundry_rotation_settings settings
  where settings.household_id = acting_household_id;

  normalized_people_per_day := least(
    greatest(coalesce(current_people_per_day, 2), 1),
    greatest(coalesce(cardinality(ordered_member_ids), 0), 1)
  );
  normalized_anchor_member_id := rotation_anchor_member_id;

  -- Clientes anteriores permitiam escolher qualquer pessoa como âncora. Se a
  -- política atual usa grupos fixos, recua para o início do bloco que contém a
  -- pessoa escolhida, mantendo a chamada antiga compatível.
  if coalesce(current_allow_incomplete, true) then
    select provided.position::integer into anchor_position
    from unnest(ordered_member_ids) with ordinality as provided(value, position)
    where provided.value = rotation_anchor_member_id;

    if anchor_position is not null then
      select provided.value into normalized_anchor_member_id
      from unnest(ordered_member_ids) with ordinality as provided(value, position)
      where provided.position = (
        ((anchor_position - 1) / normalized_people_per_day)
        * normalized_people_per_day
      ) + 1;
    end if;
  end if;

  perform public.set_laundry_rotation(
    rotation_anchor_date,
    normalized_anchor_member_id,
    rotation_gap_days,
    normalized_people_per_day,
    coalesce(current_allow_incomplete, true),
    ordered_member_ids
  );
end;
$$;

revoke all on function public.set_laundry_rotation(date, uuid, integer, uuid[])
  from public;
grant execute on function public.set_laundry_rotation(date, uuid, integer, uuid[])
  to authenticated;

comment on table public.laundry_rotation_versions is
  'Configurações versionadas da escala; cada versão vale de effective_from até a próxima.';
comment on column public.laundry_rotation_versions.allow_incomplete_last_group is
  'True fecha cada rodada com grupo menor; false mantém sempre people_per_day em fluxo circular.';
