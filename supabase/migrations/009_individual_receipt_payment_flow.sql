-- Casa Cinco — comprovante e baixa da compra somente pelas páginas individuais.
-- Rode depois da 008_admin_only_shopping.sql.

-- Quem recebeu o PIX é a única pessoa que pode confirmar o pagamento.
-- A parcela precisa continuar pendente e possuir um comprovante anexado pelo
-- devedor antes que qualquer parcela usada no acerto líquido seja quitada.
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
    and s.receipt_uploaded_at is not null
    and profile.status = 'active'
    and profile.household_id = p.household_id
    and profile.member_id = p.paid_by_member_id;

  if debtor_member_id is null then
    raise exception 'O pagamento só pode ser marcado como pago pelo recebedor e depois do envio do comprovante.';
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

-- Os rateios antigos já foram migrados para o modelo consolidado pela 006.
-- Remove a função legada como caminho alternativo de confirmação.
revoke execute on function public.confirm_shopping_share_payment(uuid) from authenticated;
