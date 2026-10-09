-- Rodizio de pagamento do galao de agua, sugestoes vindas das compras e
-- historico de confirmacoes. Rode depois da 029_laundry_responsibles_and_reminders.sql.

-- A configuracao guarda somente o estado atual. A ordem e o historico ficam
-- em tabelas separadas para que uma alteracao nao apague pagamentos antigos.
create table if not exists public.water_gallon_rotation_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  current_member_id uuid references public.household_members(id) on delete set null,
  current_since timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.water_gallon_rotation_members (
  household_id uuid not null references public.households(id) on delete cascade,
  member_id uuid not null,
  rotation_order integer not null check (rotation_order > 0),
  created_at timestamptz not null default now(),
  primary key (household_id, member_id),
  unique (household_id, rotation_order),
  foreign key (household_id, member_id)
    references public.household_members(household_id, id) on delete cascade
);

create table if not exists public.water_gallon_payments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  -- Os nomes sao snapshots para preservar o historico caso um morador seja
  -- renomeado ou removido depois.
  member_id uuid references public.household_members(id) on delete set null,
  member_name_snapshot text not null,
  paid_on date not null,
  source text not null check (source in ('initial', 'manual', 'shopping_purchase')),
  purchase_id uuid unique references public.shopping_purchases(id) on delete set null,
  next_member_id uuid references public.household_members(id) on delete set null,
  next_member_name_snapshot text not null,
  confirmed_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.water_gallon_purchase_reviews (
  purchase_id uuid primary key references public.shopping_purchases(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  matched_member_id uuid references public.household_members(id) on delete set null,
  matched_member_name_snapshot text not null,
  decision text not null check (decision in ('confirmed', 'rejected')),
  payment_id uuid unique,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  constraint water_gallon_review_payment_check check (
    (decision = 'confirmed' and payment_id is not null)
    or (decision = 'rejected' and payment_id is null)
  )
);

-- Recria explicitamente para também corrigir instalações que receberam uma
-- versão preliminar com ON DELETE SET NULL, incompatível com o check acima.
alter table public.water_gallon_purchase_reviews
  drop constraint if exists water_gallon_purchase_reviews_payment_id_fkey;
alter table public.water_gallon_purchase_reviews
  add constraint water_gallon_purchase_reviews_payment_id_fkey
  foreign key (payment_id) references public.water_gallon_payments(id)
  on delete cascade;

-- Auditoria das mudancas manuais de ordem/pessoa atual. Os UUIDs nao possuem
-- FK de proposito: sao snapshots e devem sobreviver a remocao de moradores.
create table if not exists public.water_gallon_rotation_changes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  change_type text not null check (
    change_type in ('initialized', 'order_updated', 'current_member_changed')
  ),
  previous_current_member_id uuid,
  current_member_id uuid,
  ordered_member_ids uuid[] not null default array[]::uuid[],
  note text,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists water_gallon_rotation_members_order_idx
  on public.water_gallon_rotation_members(household_id, rotation_order);
create index if not exists water_gallon_payments_history_idx
  on public.water_gallon_payments(household_id, paid_on desc, created_at desc);
create index if not exists water_gallon_reviews_household_idx
  on public.water_gallon_purchase_reviews(household_id, decided_at desc);
create index if not exists water_gallon_changes_history_idx
  on public.water_gallon_rotation_changes(household_id, changed_at desc);

alter table public.water_gallon_rotation_settings enable row level security;
alter table public.water_gallon_rotation_members enable row level security;
alter table public.water_gallon_payments enable row level security;
alter table public.water_gallon_purchase_reviews enable row level security;
alter table public.water_gallon_rotation_changes enable row level security;

drop policy if exists water_gallon_rotation_settings_read
  on public.water_gallon_rotation_settings;
create policy water_gallon_rotation_settings_read
on public.water_gallon_rotation_settings for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists water_gallon_rotation_members_read
  on public.water_gallon_rotation_members;
create policy water_gallon_rotation_members_read
on public.water_gallon_rotation_members for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists water_gallon_payments_read
  on public.water_gallon_payments;
create policy water_gallon_payments_read
on public.water_gallon_payments for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists water_gallon_purchase_reviews_read
  on public.water_gallon_purchase_reviews;
create policy water_gallon_purchase_reviews_read
on public.water_gallon_purchase_reviews for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists water_gallon_rotation_changes_read
  on public.water_gallon_rotation_changes;
create policy water_gallon_rotation_changes_read
on public.water_gallon_rotation_changes for select to authenticated
using (household_id = public.current_household_id());

-- Nenhuma tabela aceita escrita direta do cliente. As mutacoes abaixo sao
-- SECURITY DEFINER, verificam o administrador e mantem estado/historico juntos.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.water_gallon_rotation_settings from anon;
    revoke all on table public.water_gallon_rotation_members from anon;
    revoke all on table public.water_gallon_payments from anon;
    revoke all on table public.water_gallon_purchase_reviews from anon;
    revoke all on table public.water_gallon_rotation_changes from anon;
  end if;
end;
$$;

revoke all on table public.water_gallon_rotation_settings from authenticated;
revoke all on table public.water_gallon_rotation_members from authenticated;
revoke all on table public.water_gallon_payments from authenticated;
revoke all on table public.water_gallon_purchase_reviews from authenticated;
revoke all on table public.water_gallon_rotation_changes from authenticated;
grant select on table public.water_gallon_rotation_settings to authenticated;
grant select on table public.water_gallon_rotation_members to authenticated;
grant select on table public.water_gallon_payments to authenticated;
grant select on table public.water_gallon_purchase_reviews to authenticated;
grant select on table public.water_gallon_rotation_changes to authenticated;

-- Normalizacao sem depender da extensao unaccent. Ela e usada tanto para
-- reconhecer os moradores do seed quanto para identificar nomes como
-- "galao", "galão", "garrafao", "garrafão" e "agua 20 L".
create or replace function public.normalize_water_gallon_text(input_text text)
returns text
language sql
immutable
set search_path = public
as $$
  select trim(regexp_replace(
    translate(
      lower(coalesce(input_text, '')),
      'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
      'aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc'
    ),
    '[^a-z0-9]+',
    ' ',
    'g'
  ));
$$;

create or replace function public.is_water_gallon_item_name(item_name text)
returns boolean
language sql
immutable
set search_path = public
as $$
  with normalized as (
    select public.normalize_water_gallon_text(item_name) as value
  )
  select
    value !~ '(^| )agua (sanitaria|oxigenada)( |$)'
    and (
      value ~ '(^| )(galao|garrafao|bombona)( |$)'
      or value ~ '(^| )agua( |.* )(10|20)[ ]*(l|litro|litros)( |$)'
      or value ~ '(^| )(10|20)[ ]*(l|litro|litros)( |.* )agua( |$)'
    )
  from normalized;
$$;

revoke all on function public.normalize_water_gallon_text(text) from public;
revoke all on function public.is_water_gallon_item_name(text) from public;

-- Retorna a proxima pessoa ativa da ordem, dando a volta no final. Com apenas
-- uma pessoa, ela propria continua sendo a proxima.
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
    case when rotation.rotation_order > current_position.rotation_order then 0 else 1 end,
    rotation.rotation_order
  limit 1;
$$;

revoke all on function public.next_water_gallon_member(uuid, uuid) from public;

-- Consulta pronta para a pagina. Compras rejeitadas/confirmadas nao voltam,
-- compras anteriores ao inicio da vez atual tambem nao aparecem, e o pagador
-- precisa continuar sendo exatamente a pessoa da vez.
create or replace function public.get_water_gallon_purchase_suggestions()
returns table (
  purchase_id uuid,
  paid_by_member_id uuid,
  paid_by_member_name text,
  bought_at timestamptz,
  total_amount numeric,
  item_names text[],
  items jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    purchase.id as purchase_id,
    purchase.paid_by_member_id,
    payer.name as paid_by_member_name,
    purchase.bought_at,
    purchase.total_amount,
    array_agg(item.name order by item.created_at, item.id) as item_names,
    jsonb_agg(
      jsonb_build_object(
        'id', item.id,
        'name', item.name,
        'quantity', item.quantity_bought,
        'unitPrice', item.unit_price,
        'matchesWaterGallon', public.is_water_gallon_item_name(item.name)
      ) order by item.created_at, item.id
    ) as items
  from public.water_gallon_rotation_settings settings
  join public.shopping_purchases purchase
    on purchase.household_id = settings.household_id
   and purchase.paid_by_member_id = settings.current_member_id
   and purchase.bought_at >= settings.current_since
  join public.household_members payer
    on payer.household_id = purchase.household_id
   and payer.id = purchase.paid_by_member_id
  join public.shopping_items item on item.purchase_id = purchase.id
  where settings.household_id = public.current_household_id()
    and not exists (
      select 1
      from public.water_gallon_purchase_reviews review
      where review.purchase_id = purchase.id
    )
    and exists (
      select 1
      from public.shopping_items candidate_item
      where candidate_item.purchase_id = purchase.id
        and public.is_water_gallon_item_name(candidate_item.name)
    )
  group by
    purchase.id,
    purchase.paid_by_member_id,
    payer.name,
    purchase.bought_at,
    purchase.total_amount
  order by purchase.bought_at desc, purchase.id;
$$;

revoke all on function public.get_water_gallon_purchase_suggestions() from public;
grant execute on function public.get_water_gallon_purchase_suggestions() to authenticated;

create or replace function public.set_water_gallon_rotation(
  ordered_member_ids uuid[],
  target_current_member_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode configurar o rodizio de agua.';
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
$$;

revoke all on function public.set_water_gallon_rotation(uuid[], uuid) from public;
grant execute on function public.set_water_gallon_rotation(uuid[], uuid) to authenticated;

create or replace function public.set_water_gallon_current_member(
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
$$;

revoke all on function public.set_water_gallon_current_member(uuid, text) from public;
grant execute on function public.set_water_gallon_current_member(uuid, text) to authenticated;

-- Remove a assinatura preliminar sem a pessoa esperada, caso esta migration
-- tenha sido aplicada durante o desenvolvimento. Sem esse valor, um retry de
-- uma tela antiga poderia confirmar por engano a pessoa seguinte.
drop function if exists public.record_water_gallon_payment(date, text);

create or replace function public.record_water_gallon_payment(
  payment_date date,
  payment_note text,
  expected_member_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode confirmar pagamentos do galao.';
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
$$;

revoke all on function public.record_water_gallon_payment(date, text, uuid) from public;
grant execute on function public.record_water_gallon_payment(date, text, uuid) to authenticated;

create or replace function public.review_water_gallon_purchase(
  target_purchase_id uuid,
  review_decision text
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
    or acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode revisar sugestoes do galao.';
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
$$;

revoke all on function public.review_water_gallon_purchase(uuid, text) from public;
grant execute on function public.review_water_gallon_purchase(uuid, text) to authenticated;

-- Estado inicial solicitado, restrito a Casa Cinco. Os UUIDs nao sao
-- presumidos: cada papel e resolvido pelo nome atual, exige exatamente uma
-- correspondencia ativa e exige cinco pessoas distintas. Se algum cadastro
-- nao corresponder, o seed simplesmente nao altera casa alguma.
do $$
declare
  target_household_id constant uuid := '11111111-1111-1111-1111-111111111111'::uuid;
  vitor_id uuid;
  will_id uuid;
  savio_id uuid;
  patrick_id uuid;
  belo_id uuid;
  vitor_matches integer;
  will_matches integer;
  savio_matches integer;
  patrick_matches integer;
  belo_matches integer;
  active_member_count integer;
  seeded_order uuid[];
begin
  if not exists (
    select 1 from public.households where id = target_household_id
  ) then
    return;
  end if;

  select count(*)::integer into active_member_count
  from public.household_members
  where household_id = target_household_id
    and active = true;

  if active_member_count <> 5 then
    return;
  end if;

  select (array_agg(member.id order by member.id))[1], count(*)::integer
    into vitor_id, vitor_matches
  from public.household_members member
  where member.household_id = target_household_id
    and member.active = true
    and public.normalize_water_gallon_text(member.name) ~ '^vitor( |$)';

  select (array_agg(member.id order by member.id))[1], count(*)::integer
    into will_id, will_matches
  from public.household_members member
  where member.household_id = target_household_id
    and member.active = true
    and public.normalize_water_gallon_text(member.name) ~ '(^| )(will|william)( |$)';

  select (array_agg(member.id order by member.id))[1], count(*)::integer
    into savio_id, savio_matches
  from public.household_members member
  where member.household_id = target_household_id
    and member.active = true
    and public.normalize_water_gallon_text(member.name) ~ '^savio( |$)';

  select (array_agg(member.id order by member.id))[1], count(*)::integer
    into patrick_id, patrick_matches
  from public.household_members member
  where member.household_id = target_household_id
    and member.active = true
    and public.normalize_water_gallon_text(member.name) ~ '^patrick( |$)';

  select (array_agg(member.id order by member.id))[1], count(*)::integer
    into belo_id, belo_matches
  from public.household_members member
  where member.household_id = target_household_id
    and member.active = true
    and public.normalize_water_gallon_text(member.name) ~ '(^| )belo( |$)';

  if vitor_matches <> 1
    or will_matches <> 1
    or savio_matches <> 1
    or patrick_matches <> 1
    or belo_matches <> 1 then
    return;
  end if;

  seeded_order := array[vitor_id, will_id, savio_id, patrick_id, belo_id];
  if (select count(distinct member_id) from unnest(seeded_order) member_id) <> 5 then
    return;
  end if;

  if exists (
    select 1
    from public.water_gallon_rotation_settings
    where household_id = target_household_id
  ) then
    return;
  end if;

  insert into public.water_gallon_rotation_settings (
    household_id,
    current_member_id,
    current_since
  ) values (
    target_household_id,
    patrick_id,
    '2026-10-08 00:00:00 America/Sao_Paulo'::timestamptz
  );

  insert into public.water_gallon_rotation_members (
    household_id,
    member_id,
    rotation_order
  )
  select target_household_id, member_id, position::integer
  from unnest(seeded_order) with ordinality as seed(member_id, position);

  insert into public.water_gallon_payments (
    household_id,
    member_id,
    member_name_snapshot,
    paid_on,
    source,
    next_member_id,
    next_member_name_snapshot,
    note
  )
  select
    target_household_id,
    savio.id,
    savio.name,
    '2026-10-07'::date,
    'initial',
    patrick.id,
    patrick.name,
    'Ultima compra informada ao iniciar o rodizio.'
  from public.household_members savio
  join public.household_members patrick
    on patrick.household_id = savio.household_id
   and patrick.id = patrick_id
  where savio.household_id = target_household_id
    and savio.id = savio_id;

  insert into public.water_gallon_rotation_changes (
    household_id,
    change_type,
    current_member_id,
    ordered_member_ids,
    note
  ) values (
    target_household_id,
    'initialized',
    patrick_id,
    seeded_order,
    'Ordem inicial: Vitor, Will, Savio, Patrick e Belo.'
  );
end;
$$;
