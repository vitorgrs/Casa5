-- Pagamentos administrativos sem comprovante para despesas e acertos.
-- Rode depois da 016_admin_daily_standard_tasks.sql.

alter table public.expense_shares
  add column if not exists paid_amount numeric(12,2),
  add column if not exists payment_recorded_by uuid references auth.users(id) on delete set null;

update public.expense_shares
set paid_amount = amount
where payment_status = 'paid'::public.share_status
  and paid_amount is null;

do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'expense_shares_paid_amount_nonnegative'
      and conrelid = 'public.expense_shares'::regclass
  ) then
    alter table public.expense_shares
      add constraint expense_shares_paid_amount_nonnegative
      check (paid_amount is null or paid_amount >= 0);
  end if;
end $$;

-- Mantém a exigência de comprovante para todos os moradores e abre a exceção
-- somente para um administrador ativo da mesma casa.
create or replace function public.require_expense_receipt_before_paid()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_admin boolean := false;
begin
  select exists (
    select 1
    from public.profiles profile
    join public.expenses expense on expense.id = new.expense_id
    where profile.id = auth.uid()
      and profile.status = 'active'
      and profile.role = 'admin'::public.user_role
      and profile.household_id = expense.household_id
  ) into acting_is_admin;

  if new.payment_status = 'paid'::public.share_status then
    if nullif(btrim(new.receipt_path), '') is null and not acting_is_admin then
      raise exception 'Anexe o comprovante antes de marcar esta parcela como paga.';
    end if;

    if new.paid_amount is null and new.receipt_path is not null then
      new.paid_amount := new.amount;
    end if;
    if new.paid_amount is null or new.paid_amount <= 0 then
      raise exception 'Informe um valor pago maior que zero.';
    end if;
    if new.paid_amount > new.amount then
      raise exception 'O valor pago não pode ultrapassar o valor da parcela.';
    end if;
    if not acting_is_admin and new.paid_amount is distinct from new.amount then
      raise exception 'Somente o administrador pode alterar o valor efetivamente pago.';
    end if;
  else
    new.paid_amount := null;
    new.payment_recorded_by := null;
  end if;

  return new;
end;
$$;

-- As validações anteriores só aceitavam PIX com comprovante ou compensação.
-- O novo tipo admin_manual registra uma baixa já confirmada e sem arquivo.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select constraint_info.conname
    from pg_constraint constraint_info
    where constraint_info.conrelid = 'public.shopping_settlement_payments'::regclass
      and constraint_info.contype = 'c'
      and pg_get_constraintdef(constraint_info.oid) ilike '%payment_kind%'
  loop
    execute format(
      'alter table public.shopping_settlement_payments drop constraint %I',
      constraint_row.conname
    );
  end loop;
end $$;

alter table public.shopping_settlement_payments
  add constraint shopping_settlement_payments_payment_kind_check
    check (payment_kind in ('pix', 'compensation', 'admin_manual')),
  add constraint shopping_settlement_payments_payment_shape_check
    check (
      (payment_kind = 'pix' and amount > 0 and receipt_path is not null)
      or (payment_kind = 'compensation' and amount = 0)
      or (payment_kind = 'admin_manual' and amount > 0 and receipt_path is null)
    );

create or replace function public.record_shopping_net_payment_as_admin(
  target_share_id uuid,
  paid_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_share_id uuid := target_share_id;
  v_admin_profile public.profiles%rowtype;
  v_debtor_member_id uuid;
  v_creditor_member_id uuid;
  v_household_id uuid;
  v_gross_outgoing_cents bigint;
  v_gross_incoming_cents bigint;
  v_net_cents bigint;
  v_paid_cents bigint;
  v_reciprocal_cents bigint;
  v_payment_id uuid;
  v_cutoff timestamptz := now();
begin
  select profile.* into v_admin_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.role = 'admin'::public.user_role
    and profile.household_id is not null;

  if v_admin_profile.id is null then
    raise exception 'Somente o administrador pode registrar um pagamento sem comprovante.';
  end if;

  select share.member_id, purchase.paid_by_member_id, purchase.household_id
    into v_debtor_member_id, v_creditor_member_id, v_household_id
  from public.shopping_purchase_shares share
  join public.shopping_purchases purchase on purchase.id = share.purchase_id
  where share.id = v_target_share_id
    and share.payment_status = 'pending'::public.share_status
    and share.amount > share.settled_amount
    and purchase.household_id = v_admin_profile.household_id
    and share.member_id <> purchase.paid_by_member_id
  for update of share;

  if v_debtor_member_id is null then
    raise exception 'Acerto em aberto não encontrado.';
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
    submitted_by,
    submitted_at,
    confirmed_by,
    confirmed_at
  ) values (
    v_household_id,
    v_debtor_member_id,
    v_creditor_member_id,
    v_target_share_id,
    v_paid_cents / 100.0,
    'admin_manual',
    'confirmed',
    auth.uid(),
    v_cutoff,
    auth.uid(),
    v_cutoff
  ) returning id into v_payment_id;

  -- Pagamentos parciais baixam apenas o valor informado.
  perform public.apply_shopping_settlement_amount(
    v_household_id,
    v_debtor_member_id,
    v_creditor_member_id,
    v_paid_cents,
    v_cutoff
  );

  -- Quando o pagamento completa o saldo líquido, fecha também a parte que se
  -- compensa nos dois sentidos, sem aumentar o valor registrado como pago.
  if v_paid_cents = v_net_cents then
    v_reciprocal_cents := v_gross_incoming_cents;
    if v_reciprocal_cents > 0 then
      perform public.apply_shopping_settlement_amount(
        v_household_id,
        v_debtor_member_id,
        v_creditor_member_id,
        v_reciprocal_cents,
        v_cutoff
      );
      perform public.apply_shopping_settlement_amount(
        v_household_id,
        v_creditor_member_id,
        v_debtor_member_id,
        v_reciprocal_cents,
        v_cutoff
      );
    end if;
  end if;

  return v_payment_id;
end;
$$;

revoke all on function public.record_shopping_net_payment_as_admin(uuid, numeric) from public;
grant execute on function public.record_shopping_net_payment_as_admin(uuid, numeric) to authenticated;
