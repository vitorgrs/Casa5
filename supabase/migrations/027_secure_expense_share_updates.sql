-- Restringe mutações financeiras das parcelas a RPCs que validam casa,
-- permissão e campos permitidos. A policy anterior permitia que qualquer
-- perfil com mark_expenses_paid alterasse amount, member_id e receipt_path
-- diretamente pela API.
-- Rode depois da 026_atomic_recurring_expenses.sql.

create or replace function public.set_expense_share_payment(
  target_share_id uuid,
  target_status text,
  target_paid_amount numeric,
  record_as_admin boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  target_share public.expense_shares%rowtype;
  target_expense_id uuid;
  saved_paid_amount numeric(12,2);
begin
  select profile.*
  into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('mark_expenses_paid') then
    raise exception 'Você não tem permissão para alterar pagamentos.';
  end if;
  if target_status is null or target_status not in ('paid', 'pending') then
    raise exception 'Status de pagamento inválido.';
  end if;
  if coalesce(record_as_admin, false)
    and acting_profile.role <> 'admin'::public.user_role then
    raise exception 'Somente o administrador pode registrar pagamentos manuais.';
  end if;

  select share_row.expense_id
  into target_expense_id
  from public.expense_shares share_row
  join public.expenses expense on expense.id = share_row.expense_id
  where share_row.id = target_share_id
    and expense.household_id = acting_profile.household_id;

  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;

  -- Todas as mutações de uma despesa seguem a mesma ordem de locks usada
  -- por save_expense_with_shares: primeiro o pai, depois suas parcelas.
  perform 1
  from public.expenses expense
  where expense.id = target_expense_id
    and expense.household_id = acting_profile.household_id
  for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;

  select share_row.*
  into target_share
  from public.expense_shares share_row
  where share_row.id = target_share_id
    and share_row.expense_id = target_expense_id
  for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;

  if target_status = 'paid' then
    if not coalesce(record_as_admin, false)
      and nullif(btrim(target_share.receipt_path), '') is null then
      raise exception 'Anexe o comprovante antes de marcar esta parcela como paga.';
    end if;

    saved_paid_amount := round(
      coalesce(target_paid_amount, target_share.amount),
      2
    );
    if saved_paid_amount <= 0 then
      raise exception 'Informe um valor pago maior que zero.';
    end if;
    if saved_paid_amount > target_share.amount then
      raise exception 'O valor pago não pode ultrapassar o valor da parcela.';
    end if;
    if not coalesce(record_as_admin, false)
      and saved_paid_amount is distinct from target_share.amount then
      raise exception 'Somente o administrador pode alterar o valor efetivamente pago.';
    end if;
  else
    saved_paid_amount := null;
  end if;

  update public.expense_shares
  set payment_status = target_status::public.share_status,
      paid_amount = saved_paid_amount,
      paid_at = case when target_status = 'paid' then now() else null end,
      payment_method = case
        when target_status <> 'paid' then null
        when coalesce(record_as_admin, false)
          then 'Registro manual do administrador'
        else 'Mercado Pago / Pix'
      end,
      payment_recorded_by = case
        when target_status = 'paid' then acting_profile.id
        else null
      end
  where id = target_share.id;

  update public.expenses expense
  set status = case
    when expense.amount is null then 'planned'::public.expense_status
    when exists (
      select 1
      from public.expense_shares share_row
      where share_row.expense_id = target_expense_id
    ) and not exists (
      select 1
      from public.expense_shares share_row
      where share_row.expense_id = target_expense_id
        and share_row.payment_status not in (
          'paid'::public.share_status,
          'waived'::public.share_status
        )
    ) then 'paid'::public.expense_status
    else 'open'::public.expense_status
  end
  where expense.id = target_expense_id;

  return target_expense_id;
end;
$$;

create or replace function public.set_expense_share_reimbursement(
  target_share_id uuid,
  target_status text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  target_expense_id uuid;
  current_status text;
begin
  select profile.*
  into acting_profile
  from public.profiles profile
  where profile.id = auth.uid()
    and profile.status = 'active'
    and profile.household_id is not null;

  if acting_profile.id is null
    or not public.has_permission('mark_expenses_paid') then
    raise exception 'Você não tem permissão para alterar reembolsos.';
  end if;
  if target_status is null or target_status not in ('paid', 'pending') then
    raise exception 'Status de reembolso inválido.';
  end if;

  select share_row.expense_id
  into target_expense_id
  from public.expense_shares share_row
  join public.expenses expense on expense.id = share_row.expense_id
  where share_row.id = target_share_id
    and expense.household_id = acting_profile.household_id;

  if not found then
    raise exception 'Reembolso não encontrado.';
  end if;

  perform 1
  from public.expenses expense
  where expense.id = target_expense_id
    and expense.household_id = acting_profile.household_id
  for update;
  if not found then
    raise exception 'Reembolso não encontrado.';
  end if;

  select share_row.reimbursement_status
  into current_status
  from public.expense_shares share_row
  where share_row.id = target_share_id
    and share_row.expense_id = target_expense_id
  for update;
  if not found then
    raise exception 'Reembolso não encontrado.';
  end if;
  if current_status = 'not_applicable' then
    raise exception 'Esta parcela não possui reembolso.';
  end if;

  update public.expense_shares
  set reimbursement_status = target_status,
      reimbursement_paid_at = case
        when target_status = 'paid' then now()
        else null
      end
  where id = target_share_id;

  return target_expense_id;
end;
$$;

revoke all on function public.set_expense_share_payment(
  uuid, text, numeric, boolean
) from public;
grant execute on function public.set_expense_share_payment(
  uuid, text, numeric, boolean
) to authenticated;

revoke all on function public.set_expense_share_reimbursement(uuid, text)
  from public;
grant execute on function public.set_expense_share_reimbursement(uuid, text)
  to authenticated;

-- Cadastro/rateio passam por save_expense_with_shares; comprovantes e cron usam
-- service role. Portanto nenhum perfil autenticado precisa mutar a tabela
-- diretamente. O cascade de expenses continua sendo executado pelo banco.
drop policy if exists shares_permission_update on public.expense_shares;
drop policy if exists shares_permission_write on public.expense_shares;
drop policy if exists shares_admin_all on public.expense_shares;
revoke insert, update, delete on table public.expense_shares from authenticated;
