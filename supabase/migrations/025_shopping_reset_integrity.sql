-- Impede que "Voltar itens à lista" apague compras que já fazem parte do
-- histórico de comprovantes, pagamentos ou compensações.
-- Rode depois da 024_secure_receipt_storage.sql.

create or replace function public.reset_shopping_purchase(
  target_purchase_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_household_id uuid;
  target_payer_member_id uuid;
begin
  if not public.has_permission('manage_shopping') then
    raise exception 'Você não tem permissão para desfazer compras.';
  end if;

  select household_id, paid_by_member_id
  into target_household_id, target_payer_member_id
  from public.shopping_purchases
  where id = target_purchase_id
    and household_id = public.current_household_id()
  for update;

  if target_household_id is null then
    raise exception 'Compra não encontrada.';
  end if;

  perform 1
  from public.shopping_purchase_shares
  where purchase_id = target_purchase_id
  for update;

  if exists (
    select 1
    from public.shopping_purchase_shares share
    where share.purchase_id = target_purchase_id
      and (
        share.receipt_path is not null
        or coalesce(share.settled_amount, 0) > 0
        or (
          share.member_id <> target_payer_member_id
          and share.payment_status in (
            'paid'::public.share_status,
            'waived'::public.share_status
          )
        )
      )
  ) or exists (
    select 1
    from public.shopping_settlement_payments payment
    join public.shopping_purchase_shares share
      on share.id = payment.target_share_id
    where share.purchase_id = target_purchase_id
  ) then
    raise exception 'Não é possível desfazer uma compra que já possui comprovante, pagamento ou compensação registrado.';
  end if;

  update public.shopping_items
  set status = 'list',
      checked_at = null,
      bought_at = null,
      quantity_bought = null,
      unit_price = null,
      purchase_scope = null,
      paid_by_member_id = null,
      purchase_id = null
  where purchase_id = target_purchase_id
    and household_id = target_household_id;

  delete from public.shopping_purchases
  where id = target_purchase_id
    and household_id = target_household_id;
end;
$$;

revoke all on function public.reset_shopping_purchase(uuid) from public;
grant execute on function public.reset_shopping_purchase(uuid) to authenticated;
