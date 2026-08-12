-- Casa Cinco — corrige a confirmação de pagamentos parciais.
-- Rode depois da 012_partial_shopping_settlements_history.sql.

-- Um pagamento parcial deve liquidar somente o valor informado no comprovante.
-- As dívidas recíprocas permanecem disponíveis para o cálculo do saldo em
-- aberto. Quando o pagamento completa todo o saldo líquido, a compensação
-- restante é aplicada automaticamente nos dois sentidos.
create or replace function public.confirm_shopping_net_payment(target_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
      or profile.role = 'admin'::public.user_role
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
$$;

revoke all on function public.confirm_shopping_net_payment(uuid) from public;
grant execute on function public.confirm_shopping_net_payment(uuid) to authenticated;
