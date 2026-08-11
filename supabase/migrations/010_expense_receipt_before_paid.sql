-- Casa Cinco — exige comprovante antes de quitar uma parcela de despesa.
-- Rode depois da 009_individual_receipt_payment_flow.sql.

create or replace function public.require_expense_receipt_before_paid()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.payment_status = 'paid'::public.share_status
    and nullif(btrim(new.receipt_path), '') is null then
    raise exception 'Anexe o comprovante antes de marcar esta parcela como paga.';
  end if;
  return new;
end;
$$;

drop trigger if exists expense_share_receipt_before_paid on public.expense_shares;
create trigger expense_share_receipt_before_paid
before insert or update of payment_status, receipt_path
on public.expense_shares
for each row execute procedure public.require_expense_receipt_before_paid();
