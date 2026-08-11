-- Casa Cinco — compras com vários itens e compensação de dívidas entre moradores.
-- Rode depois da 005_shopping_splits.sql.

-- ============================================================
-- 1) Uma compra agrupa vários itens e possui um único rateio
-- ============================================================
create table if not exists public.shopping_purchases (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  paid_by_member_id uuid not null references public.household_members(id) on delete restrict,
  purchase_scope text not null check (purchase_scope in ('household', 'group', 'individual')),
  total_amount numeric(12,2) not null check (total_amount >= 0),
  bought_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shopping_items
  add column if not exists purchase_id uuid;

create table if not exists public.shopping_purchase_shares (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.shopping_purchases(id) on delete cascade,
  member_id uuid not null references public.household_members(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  payment_status public.share_status not null default 'pending',
  paid_at timestamptz,
  receipt_path text,
  receipt_name text,
  receipt_uploaded_by uuid references auth.users(id) on delete set null,
  receipt_uploaded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(purchase_id, member_id)
);

create index if not exists shopping_purchases_household_idx
  on public.shopping_purchases(household_id, bought_at desc);
create index if not exists shopping_purchases_payer_idx
  on public.shopping_purchases(paid_by_member_id, bought_at desc);
create index if not exists shopping_purchase_shares_member_idx
  on public.shopping_purchase_shares(member_id, payment_status);
create index if not exists shopping_items_purchase_idx
  on public.shopping_items(purchase_id);

drop trigger if exists shopping_purchases_updated_at on public.shopping_purchases;
create trigger shopping_purchases_updated_at
before update on public.shopping_purchases
for each row execute procedure public.set_updated_at();

drop trigger if exists shopping_purchase_shares_updated_at on public.shopping_purchase_shares;
create trigger shopping_purchase_shares_updated_at
before update on public.shopping_purchase_shares
for each row execute procedure public.set_updated_at();

-- Converte lançamentos feitos pela migração 005 em compras de um item. O ID
-- do próprio item torna esta etapa idempotente mesmo se a migração for refeita.
insert into public.shopping_purchases (
  id, household_id, paid_by_member_id, purchase_scope, total_amount, bought_at, created_at
)
select
  i.id,
  i.household_id,
  i.paid_by_member_id,
  i.purchase_scope,
  round(coalesce(i.quantity_bought, 0) * coalesce(i.unit_price, 0), 2),
  coalesce(i.bought_at, now()),
  i.created_at
from public.shopping_items i
where i.status = 'bought'
  and i.paid_by_member_id is not null
  and i.purchase_scope is not null
  and i.purchase_id is null
on conflict (id) do nothing;

update public.shopping_items
set purchase_id = id
where status = 'bought'
  and paid_by_member_id is not null
  and purchase_scope is not null
  and purchase_id is null;

insert into public.shopping_purchase_shares (
  purchase_id, member_id, amount, payment_status, paid_at,
  receipt_path, receipt_name, receipt_uploaded_by, receipt_uploaded_at,
  created_at, updated_at
)
select
  i.purchase_id, s.member_id, s.amount, s.payment_status, s.paid_at,
  s.receipt_path, s.receipt_name, s.receipt_uploaded_by, s.receipt_uploaded_at,
  s.created_at, s.updated_at
from public.shopping_item_shares s
join public.shopping_items i on i.id = s.shopping_item_id
where i.purchase_id is not null
on conflict (purchase_id, member_id) do nothing;

do $$ begin
  alter table public.shopping_items
    add constraint shopping_items_purchase_id_fkey
    foreign key (purchase_id) references public.shopping_purchases(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ============================================================
-- 2) RLS
-- ============================================================
alter table public.shopping_purchases enable row level security;
alter table public.shopping_purchase_shares enable row level security;

drop policy if exists shopping_purchases_read on public.shopping_purchases;
create policy shopping_purchases_read on public.shopping_purchases
for select to authenticated
using (household_id = public.current_household_id());

drop policy if exists shopping_purchases_manage on public.shopping_purchases;
create policy shopping_purchases_manage on public.shopping_purchases
for all to authenticated
using (household_id = public.current_household_id() and public.has_permission('manage_shopping'))
with check (household_id = public.current_household_id() and public.has_permission('manage_shopping'));

drop policy if exists shopping_purchase_shares_read on public.shopping_purchase_shares;
create policy shopping_purchase_shares_read on public.shopping_purchase_shares
for select to authenticated
using (exists (
  select 1 from public.shopping_purchases p
  where p.id = purchase_id and p.household_id = public.current_household_id()
));

drop policy if exists shopping_purchase_shares_manage on public.shopping_purchase_shares;
create policy shopping_purchase_shares_manage on public.shopping_purchase_shares
for all to authenticated
using (exists (
  select 1 from public.shopping_purchases p
  where p.id = purchase_id
    and p.household_id = public.current_household_id()
    and public.has_permission('manage_shopping')
))
with check (exists (
  select 1 from public.shopping_purchases p
  where p.id = purchase_id
    and p.household_id = public.current_household_id()
    and public.has_permission('manage_shopping')
));

-- ============================================================
-- 3) Registro atômico de uma compra com vários itens
-- ============================================================
create or replace function public.record_multi_item_shopping_purchase(
  target_item_ids uuid[],
  purchased_quantities numeric[],
  purchased_unit_prices numeric[],
  selected_scope text,
  payer_member_id uuid,
  participant_member_ids uuid[]
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_household_id uuid := public.current_household_id();
  normalized_participants uuid[];
  participant_count integer;
  valid_member_count integer;
  valid_item_count integer;
  total_cents bigint := 0;
  item_cents bigint;
  base_cents bigint;
  remaining_cents bigint;
  current_member_id uuid;
  current_position integer := 0;
  current_quantity numeric;
  current_unit_price numeric;
  item_position integer;
  new_purchase_id uuid := gen_random_uuid();
begin
  if not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para registrar compras.';
  end if;

  if target_item_ids is null or cardinality(target_item_ids) = 0 then
    raise exception 'Selecione pelo menos um item.';
  end if;
  if cardinality(target_item_ids) <> cardinality(purchased_quantities)
    or cardinality(target_item_ids) <> cardinality(purchased_unit_prices) then
    raise exception 'Os dados dos itens estão incompletos.';
  end if;
  if (select count(distinct item_id) from unnest(target_item_ids) as ids(item_id))
    <> cardinality(target_item_ids) then
    raise exception 'Um item foi selecionado mais de uma vez.';
  end if;
  if selected_scope is null or selected_scope not in ('household', 'group', 'individual') then
    raise exception 'Tipo de compra inválido.';
  end if;

  if not exists (
    select 1 from public.household_members
    where id = payer_member_id
      and household_id = target_household_id
      and active = true
  ) then
    raise exception 'O pagador não pertence a esta casa.';
  end if;

  if selected_scope = 'household' then
    select array_agg(id order by display_order, id)
      into normalized_participants
    from public.household_members
    where household_id = target_household_id and active = true;
  else
    select array_agg(distinct participant_id order by participant_id)
      into normalized_participants
    from unnest(coalesce(participant_member_ids, array[]::uuid[]))
      as participants(participant_id);
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

  select count(*) into valid_member_count
  from public.household_members
  where id = any(normalized_participants)
    and household_id = target_household_id
    and active = true;
  if valid_member_count <> participant_count then
    raise exception 'Há um participante inválido no rateio.';
  end if;

  perform 1
  from public.shopping_items
  where id = any(target_item_ids)
    and household_id = target_household_id
  for update;

  select count(*) into valid_item_count
  from public.shopping_items
  where id = any(target_item_ids)
    and household_id = target_household_id
    and status in ('list'::public.shopping_status, 'checked'::public.shopping_status);
  if valid_item_count <> cardinality(target_item_ids) then
    raise exception 'Há um item inválido ou já comprado na seleção.';
  end if;

  for item_position in 1..cardinality(target_item_ids) loop
    current_quantity := round(purchased_quantities[item_position], 2);
    current_unit_price := round(purchased_unit_prices[item_position], 2);
    if current_quantity is null or current_unit_price is null
      or current_quantity <= 0 or current_unit_price < 0 then
      raise exception 'Quantidade ou valor inválido no item %.', item_position;
    end if;
    item_cents := round(current_quantity * current_unit_price * 100)::bigint;
    total_cents := total_cents + item_cents;
  end loop;

  insert into public.shopping_purchases (
    id, household_id, paid_by_member_id, purchase_scope,
    total_amount, bought_at, created_by
  ) values (
    new_purchase_id, target_household_id, payer_member_id, selected_scope,
    total_cents / 100.0, now(), auth.uid()
  );

  for item_position in 1..cardinality(target_item_ids) loop
    current_quantity := round(purchased_quantities[item_position], 2);
    current_unit_price := round(purchased_unit_prices[item_position], 2);
    update public.shopping_items
    set status = 'bought',
        quantity_bought = current_quantity,
        unit_price = current_unit_price,
        purchase_scope = selected_scope,
        paid_by_member_id = payer_member_id,
        purchase_id = new_purchase_id,
        bought_at = now()
    where id = target_item_ids[item_position];
  end loop;

  base_cents := total_cents / participant_count;
  remaining_cents := total_cents - (base_cents * participant_count);
  foreach current_member_id in array normalized_participants loop
    current_position := current_position + 1;
    insert into public.shopping_purchase_shares (
      purchase_id, member_id, amount, payment_status, paid_at
    ) values (
      new_purchase_id,
      current_member_id,
      (base_cents + case when current_position <= remaining_cents then 1 else 0 end) / 100.0,
      case when total_cents = 0 or current_member_id = payer_member_id
        then 'paid'::public.share_status else 'pending'::public.share_status end,
      case when total_cents = 0 or current_member_id = payer_member_id then now() else null end
    );
  end loop;

  return new_purchase_id;
end;
$$;

revoke all on function public.record_multi_item_shopping_purchase(uuid[], numeric[], numeric[], text, uuid, uuid[]) from public;
grant execute on function public.record_multi_item_shopping_purchase(uuid[], numeric[], numeric[], text, uuid, uuid[]) to authenticated;

create or replace function public.reset_shopping_purchase(target_purchase_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para desfazer compras.';
  end if;

  if exists (
    select 1 from public.shopping_purchase_shares
    where purchase_id = target_purchase_id
      and payment_status = 'pending'
      and receipt_path is not null
  ) then
    raise exception 'Confirme o comprovante pendente antes de desfazer esta compra.';
  end if;

  update public.shopping_items
  set status = 'list', checked_at = null, bought_at = null,
      quantity_bought = null, unit_price = null,
      purchase_scope = null, paid_by_member_id = null, purchase_id = null
  where purchase_id = target_purchase_id
    and household_id = public.current_household_id();

  delete from public.shopping_purchases
  where id = target_purchase_id
    and household_id = public.current_household_id();

  if not found then
    raise exception 'Compra não encontrada.';
  end if;
end;
$$;

revoke all on function public.reset_shopping_purchase(uuid) from public;
grant execute on function public.reset_shopping_purchase(uuid) to authenticated;

-- ============================================================
-- 4) Comprovante e quitação pelo saldo líquido entre duas pessoas
-- ============================================================
create or replace function public.submit_shopping_net_receipt(
  target_share_id uuid,
  uploaded_path text,
  uploaded_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  debtor_member_id uuid;
  creditor_member_id uuid;
  target_household_id uuid;
  gross_outgoing numeric(12,2);
  gross_incoming numeric(12,2);
begin
  select s.member_id, p.paid_by_member_id, p.household_id
    into debtor_member_id, creditor_member_id, target_household_id
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  join public.profiles profile on profile.id = auth.uid()
  where s.id = target_share_id
    and s.payment_status = 'pending'
    and profile.status = 'active'
    and profile.household_id = p.household_id
    and profile.member_id = s.member_id
    and s.member_id <> p.paid_by_member_id;

  if debtor_member_id is null then
    raise exception 'Dívida não encontrada ou não pertence a você.';
  end if;
  if uploaded_path not like target_household_id::text || '/shopping-net/' || target_share_id::text || '/%' then
    raise exception 'Caminho do comprovante inválido.';
  end if;

  select coalesce(sum(s.amount), 0) into gross_outgoing
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = debtor_member_id
    and p.paid_by_member_id = creditor_member_id
    and s.payment_status = 'pending';

  select coalesce(sum(s.amount), 0) into gross_incoming
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = creditor_member_id
    and p.paid_by_member_id = debtor_member_id
    and s.payment_status = 'pending';

  if gross_outgoing <= gross_incoming then
    raise exception 'Após a compensação, você não possui saldo a pagar para esta pessoa.';
  end if;
  if exists (
    select 1
    from public.shopping_purchase_shares s
    join public.shopping_purchases p on p.id = s.purchase_id
    where s.member_id = debtor_member_id
      and p.paid_by_member_id = creditor_member_id
      and s.payment_status = 'pending'
      and s.receipt_path is not null
  ) then
    raise exception 'Já existe um comprovante aguardando confirmação para este acerto.';
  end if;

  update public.shopping_purchase_shares s
  set receipt_path = uploaded_path,
      receipt_name = uploaded_name,
      receipt_uploaded_by = auth.uid(),
      receipt_uploaded_at = now()
  from public.shopping_purchases p
  where p.id = s.purchase_id
    and s.member_id = debtor_member_id
    and p.paid_by_member_id = creditor_member_id
    and s.payment_status = 'pending';
end;
$$;

revoke all on function public.submit_shopping_net_receipt(uuid, text, text) from public;
grant execute on function public.submit_shopping_net_receipt(uuid, text, text) to authenticated;

create or replace function public.confirm_shopping_net_payment(target_share_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  debtor_member_id uuid;
  creditor_member_id uuid;
  target_household_id uuid;
  receipt_cutoff timestamptz;
begin
  select s.member_id, p.paid_by_member_id, p.household_id, s.receipt_uploaded_at
    into debtor_member_id, creditor_member_id, target_household_id, receipt_cutoff
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  join public.profiles profile on profile.id = auth.uid()
  where s.id = target_share_id
    and s.payment_status = 'pending'
    and s.receipt_path is not null
    and profile.status = 'active'
    and profile.household_id = p.household_id
    and (
      profile.member_id = p.paid_by_member_id
      or profile.role = 'admin'::public.user_role
      or coalesce((profile.permissions ->> 'manage_shopping')::boolean, false)
    );

  if debtor_member_id is null then
    raise exception 'Comprovante não encontrado ou sem permissão para confirmação.';
  end if;

  update public.shopping_purchase_shares s
  set payment_status = 'paid', paid_at = now()
  from public.shopping_purchases p
  where p.id = s.purchase_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'
    and s.created_at <= receipt_cutoff
    and (
      (s.member_id = debtor_member_id and p.paid_by_member_id = creditor_member_id)
      or (s.member_id = creditor_member_id and p.paid_by_member_id = debtor_member_id)
    );
end;
$$;

revoke all on function public.confirm_shopping_net_payment(uuid) from public;
grant execute on function public.confirm_shopping_net_payment(uuid) to authenticated;

create or replace function public.settle_zero_shopping_balance(counterparty_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_member_id uuid;
  target_household_id uuid;
  gross_outgoing numeric(12,2);
  gross_incoming numeric(12,2);
begin
  select member_id, household_id into current_member_id, target_household_id
  from public.profiles
  where id = auth.uid() and status = 'active';

  select coalesce(sum(s.amount), 0) into gross_outgoing
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = current_member_id
    and p.paid_by_member_id = counterparty_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending';

  select coalesce(sum(s.amount), 0) into gross_incoming
  from public.shopping_purchase_shares s
  join public.shopping_purchases p on p.id = s.purchase_id
  where s.member_id = counterparty_member_id
    and p.paid_by_member_id = current_member_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending';

  if gross_outgoing = 0 or gross_outgoing <> gross_incoming then
    raise exception 'As dívidas não possuem o mesmo valor para quitação por compensação.';
  end if;

  update public.shopping_purchase_shares s
  set payment_status = 'paid', paid_at = now()
  from public.shopping_purchases p
  where p.id = s.purchase_id
    and p.household_id = target_household_id
    and s.payment_status = 'pending'
    and (
      (s.member_id = current_member_id and p.paid_by_member_id = counterparty_member_id)
      or (s.member_id = counterparty_member_id and p.paid_by_member_id = current_member_id)
    );
end;
$$;

revoke all on function public.settle_zero_shopping_balance(uuid) from public;
grant execute on function public.settle_zero_shopping_balance(uuid) to authenticated;

-- Permite ao devedor apagar um arquivo recém-enviado caso a gravação dos
-- metadados falhe. Gestores continuam com acesso para limpar compras.
drop policy if exists comprovantes_delete on storage.objects;
create policy comprovantes_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'comprovantes'
  and (storage.foldername(name))[1] = (
    select household_id::text from public.profiles where id = auth.uid()
  )
  and (
    public.is_house_admin((select household_id from public.profiles where id = auth.uid()))
    or public.has_permission('manage_expenses')
    or public.has_permission('manage_shopping')
    or (
      (storage.foldername(name))[2] = 'shopping-net'
      and exists (
        select 1
        from public.shopping_purchase_shares s
        join public.profiles p on p.id = auth.uid()
        where s.id::text = (storage.foldername(name))[3]
          and s.member_id = p.member_id
      )
    )
  )
);
