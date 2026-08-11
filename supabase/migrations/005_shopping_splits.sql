-- Casa Cinco — rateio de compras da lista, cobrança via PIX e comprovantes.
-- Rode depois da 004_receipts_storage.sql.

-- ============================================================
-- 1) Dados da compra e parcelas por participante
-- ============================================================
alter table public.shopping_items
  add column if not exists purchase_scope text,
  add column if not exists paid_by_member_id uuid references public.household_members(id) on delete set null;

alter table public.shopping_items
  drop constraint if exists shopping_items_purchase_scope_check;
alter table public.shopping_items
  add constraint shopping_items_purchase_scope_check
  check (purchase_scope is null or purchase_scope in ('household', 'group', 'individual'));

create table if not exists public.shopping_item_shares (
  id uuid primary key default gen_random_uuid(),
  shopping_item_id uuid not null references public.shopping_items(id) on delete cascade,
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
  unique(shopping_item_id, member_id)
);

create index if not exists shopping_item_shares_member_idx
  on public.shopping_item_shares(member_id, payment_status);
create index if not exists shopping_items_payer_idx
  on public.shopping_items(paid_by_member_id, bought_at desc);

drop trigger if exists shopping_item_shares_updated_at on public.shopping_item_shares;
create trigger shopping_item_shares_updated_at
before update on public.shopping_item_shares
for each row execute procedure public.set_updated_at();

-- ============================================================
-- 2) RLS
-- ============================================================
alter table public.shopping_item_shares enable row level security;

drop policy if exists shopping_item_shares_read on public.shopping_item_shares;
create policy shopping_item_shares_read on public.shopping_item_shares
for select to authenticated
using (exists (
  select 1
  from public.shopping_items i
  where i.id = shopping_item_id
    and i.household_id = public.current_household_id()
));

drop policy if exists shopping_item_shares_manage on public.shopping_item_shares;
create policy shopping_item_shares_manage on public.shopping_item_shares
for all to authenticated
using (exists (
  select 1
  from public.shopping_items i
  where i.id = shopping_item_id
    and i.household_id = public.current_household_id()
    and public.has_permission('manage_shopping')
))
with check (exists (
  select 1
  from public.shopping_items i
  where i.id = shopping_item_id
    and i.household_id = public.current_household_id()
    and public.has_permission('manage_shopping')
));

-- Quem gerencia compras também pode remover comprovantes ao desfazer ou
-- excluir uma compra. A leitura e o envio já são liberados à casa pela 004.
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
      (storage.foldername(name))[2] = 'shopping-shares'
      and exists (
        select 1
        from public.shopping_item_shares s
        join public.profiles p on p.id = auth.uid()
        where s.id::text = (storage.foldername(name))[3]
          and s.member_id = p.member_id
      )
    )
  )
);

-- ============================================================
-- 3) Registro atômico da compra e do rateio
-- ============================================================
create or replace function public.record_shopping_purchase(
  target_item_id uuid,
  purchased_quantity numeric,
  purchased_unit_price numeric,
  selected_scope text,
  payer_member_id uuid,
  participant_member_ids uuid[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_household_id uuid;
  target_status public.shopping_status;
  normalized_participants uuid[];
  participant_count integer;
  valid_member_count integer;
  total_cents bigint;
  base_cents bigint;
  remaining_cents bigint;
  current_member_id uuid;
  current_position integer := 0;
begin
  if not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para registrar compras.';
  end if;

  purchased_quantity := round(purchased_quantity, 2);
  purchased_unit_price := round(purchased_unit_price, 2);

  if purchased_quantity is null or purchased_unit_price is null
    or purchased_quantity <= 0 or purchased_unit_price < 0 then
    raise exception 'Quantidade e valor da compra são inválidos.';
  end if;

  if selected_scope is null or selected_scope not in ('household', 'group', 'individual') then
    raise exception 'Tipo de compra inválido.';
  end if;

  select household_id, status into target_household_id, target_status
  from public.shopping_items
  where id = target_item_id
    and household_id = public.current_household_id()
  for update;

  if target_household_id is null then
    raise exception 'Item da lista não encontrado.';
  end if;
  if target_status not in ('list'::public.shopping_status, 'checked'::public.shopping_status) then
    raise exception 'Esta compra já foi lançada. Volte o item à lista antes de refazer o rateio.';
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

  total_cents := round(purchased_quantity * purchased_unit_price * 100)::bigint;
  base_cents := total_cents / participant_count;
  remaining_cents := total_cents - (base_cents * participant_count);

  update public.shopping_items
  set status = 'bought',
      quantity_bought = purchased_quantity,
      unit_price = purchased_unit_price,
      purchase_scope = selected_scope,
      paid_by_member_id = payer_member_id,
      bought_at = now()
  where id = target_item_id;

  delete from public.shopping_item_shares where shopping_item_id = target_item_id;

  foreach current_member_id in array normalized_participants loop
    current_position := current_position + 1;
    insert into public.shopping_item_shares (
      shopping_item_id,
      member_id,
      amount,
      payment_status,
      paid_at
    ) values (
      target_item_id,
      current_member_id,
      (base_cents + case when current_position <= remaining_cents then 1 else 0 end) / 100.0,
      case when current_member_id = payer_member_id
        then 'paid'::public.share_status
        else 'pending'::public.share_status
      end,
      case when current_member_id = payer_member_id then now() else null end
    );
  end loop;
end;
$$;

revoke all on function public.record_shopping_purchase(uuid, numeric, numeric, text, uuid, uuid[]) from public;
grant execute on function public.record_shopping_purchase(uuid, numeric, numeric, text, uuid, uuid[]) to authenticated;

-- ============================================================
-- 4) Comprovante do devedor e confirmação do pagador
-- ============================================================
create or replace function public.submit_shopping_share_receipt(
  target_share_id uuid,
  uploaded_path text,
  uploaded_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if uploaded_path is null or uploaded_path = '' then
    raise exception 'Caminho do comprovante inválido.';
  end if;

  update public.shopping_item_shares s
  set receipt_path = uploaded_path,
      receipt_name = uploaded_name,
      receipt_uploaded_by = auth.uid(),
      receipt_uploaded_at = now()
  from public.shopping_items i, public.profiles p
  where s.id = target_share_id
    and i.id = s.shopping_item_id
    and p.id = auth.uid()
    and p.status = 'active'
    and p.household_id = i.household_id
    and p.member_id = s.member_id
    and s.payment_status = 'pending'
    and s.receipt_path is null
    and uploaded_path like i.household_id::text || '/shopping-shares/' || s.id::text || '/%';

  if not found then
    raise exception 'Parcela não encontrada, já quitada ou com comprovante enviado.';
  end if;
end;
$$;

revoke all on function public.submit_shopping_share_receipt(uuid, text, text) from public;
grant execute on function public.submit_shopping_share_receipt(uuid, text, text) to authenticated;

create or replace function public.confirm_shopping_share_payment(target_share_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
      or p.role = 'admin'::public.user_role
      or coalesce((p.permissions ->> 'manage_shopping')::boolean, false)
    );

  if not found then
    raise exception 'Pagamento sem comprovante ou sem permissão para confirmação.';
  end if;
end;
$$;

revoke all on function public.confirm_shopping_share_payment(uuid) from public;
grant execute on function public.confirm_shopping_share_payment(uuid) to authenticated;
