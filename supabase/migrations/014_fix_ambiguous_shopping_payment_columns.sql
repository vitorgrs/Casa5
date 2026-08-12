-- Casa Cinco — remove referências ambíguas no envio de pagamentos parciais.
-- Rode depois da 013_fix_partial_shopping_payment.sql.

create or replace function public.submit_shopping_net_receipt(
  target_share_id uuid,
  uploaded_path text,
  uploaded_name text,
  paid_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
      or profile.role = 'admin'::public.user_role
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
$$;

revoke all on function public.submit_shopping_net_receipt(uuid, text, text, numeric) from public;
grant execute on function public.submit_shopping_net_receipt(uuid, text, text, numeric) to authenticated;
