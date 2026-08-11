-- Casa Cinco — retirar um item de uma compra lançada e recalcular o rateio.
-- Rode depois da 006_multi_item_purchases_and_netting.sql.

create or replace function public.remove_item_from_shopping_purchase(
  target_purchase_id uuid,
  target_item_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_household_id uuid;
  payer_member_id uuid;
  purchase_item_count integer;
  participant_member_ids uuid[];
  participant_count integer;
  total_cents bigint;
  base_cents bigint;
  remaining_cents bigint;
  current_member_id uuid;
  current_position integer := 0;
begin
  if not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para alterar compras.';
  end if;

  select household_id, paid_by_member_id
    into target_household_id, payer_member_id
  from public.shopping_purchases
  where id = target_purchase_id
    and household_id = public.current_household_id()
  for update;

  if target_household_id is null then
    raise exception 'Compra não encontrada.';
  end if;

  perform 1
  from public.shopping_items
  where id = target_item_id
    and purchase_id = target_purchase_id
    and household_id = target_household_id
  for update;

  if not found then
    raise exception 'Este item não pertence à compra informada.';
  end if;

  -- Depois de um comprovante ou de uma quitação, alterar o valor apagaria a
  -- correspondência entre o pagamento feito e o rateio original.
  if exists (
    select 1
    from public.shopping_purchase_shares
    where purchase_id = target_purchase_id
      and (
        receipt_path is not null
        or (
          member_id <> payer_member_id
          and payment_status <> 'pending'::public.share_status
          and amount > 0
        )
      )
  ) then
    raise exception 'Não é possível retirar itens depois que existe comprovante ou pagamento confirmado.';
  end if;

  select count(*) into purchase_item_count
  from public.shopping_items
  where purchase_id = target_purchase_id;

  update public.shopping_items
  set status = 'list',
      checked_at = null,
      bought_at = null,
      quantity_bought = null,
      unit_price = null,
      purchase_scope = null,
      paid_by_member_id = null,
      purchase_id = null
  where id = target_item_id;

  -- Se era o único item, a compra deixa de existir e o item simplesmente
  -- volta à lista. As parcelas são removidas pelo ON DELETE CASCADE.
  if purchase_item_count = 1 then
    delete from public.shopping_purchases where id = target_purchase_id;
    return;
  end if;

  select coalesce(sum(round(quantity_bought * unit_price * 100)), 0)::bigint
    into total_cents
  from public.shopping_items
  where purchase_id = target_purchase_id;

  update public.shopping_purchases
  set total_amount = total_cents / 100.0
  where id = target_purchase_id;

  select array_agg(member_id order by created_at, id)
    into participant_member_ids
  from public.shopping_purchase_shares
  where purchase_id = target_purchase_id;

  participant_count := coalesce(cardinality(participant_member_ids), 0);
  if participant_count = 0 then
    raise exception 'A compra não possui participantes para recalcular o rateio.';
  end if;

  base_cents := total_cents / participant_count;
  remaining_cents := total_cents - (base_cents * participant_count);

  foreach current_member_id in array participant_member_ids loop
    current_position := current_position + 1;
    update public.shopping_purchase_shares
    set amount = (base_cents + case when current_position <= remaining_cents then 1 else 0 end) / 100.0,
        payment_status = case
          when total_cents = 0 or current_member_id = payer_member_id
            then 'paid'::public.share_status
          else 'pending'::public.share_status
        end,
        paid_at = case
          when total_cents = 0 or current_member_id = payer_member_id then now()
          else null
        end
    where purchase_id = target_purchase_id
      and member_id = current_member_id;
  end loop;
end;
$$;

revoke all on function public.remove_item_from_shopping_purchase(uuid, uuid) from public;
grant execute on function public.remove_item_from_shopping_purchase(uuid, uuid) to authenticated;

