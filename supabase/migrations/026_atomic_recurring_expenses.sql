-- Gera a competência seguinte de uma despesa recorrente em uma única
-- transação. A função é exclusiva da automação com service role.
-- Rode depois da 025_shopping_reset_integrity.sql.

create or replace function public.create_recurring_expense_month(
  target_household_id uuid,
  target_series_id uuid,
  target_reference_month date
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  source_expense public.expenses%rowtype;
  created_expense_id uuid;
  target_due_date date;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Esta rotina só pode ser executada pela automação.';
  end if;

  if target_reference_month is null
    or extract(day from target_reference_month) <> 1 then
    raise exception 'Informe o primeiro dia da competência de destino.';
  end if;
  if target_household_id is null or target_series_id is null then
    raise exception 'Casa ou série recorrente não informada.';
  end if;

  select expense.*
  into source_expense
  from public.expenses expense
  where expense.household_id = target_household_id
    and expense.series_id = target_series_id
    and expense.reference_month < target_reference_month
  order by expense.reference_month desc
  limit 1
  for share;

  if not found then
    raise exception 'Despesa recorrente de origem não encontrada.';
  end if;
  -- Alterar a competência mais recente para "uma vez" encerra a série sem
  -- apagar seu identificador e seu histórico anterior.
  if source_expense.recurrence <> 'monthly'::public.recurrence_type then
    return null;
  end if;
  if source_expense.has_reimbursement
    and coalesce(source_expense.reimbursement_amount, 0) <= 0 then
    raise exception 'A série possui reembolso sem valor válido.';
  end if;

  target_due_date := case
    when source_expense.due_date is null then null
    else (
      target_reference_month
      + (
        least(
          extract(day from source_expense.due_date)::integer,
          extract(
            day from (target_reference_month + interval '1 month - 1 day')
          )::integer
        ) - 1
      ) * interval '1 day'
    )::date
  end;

  insert into public.expenses (
    household_id,
    title,
    category,
    description,
    reference_month,
    due_date,
    amount,
    estimated,
    split_mode,
    status,
    recurrence,
    series_id,
    source_expense_id,
    has_reimbursement,
    reimbursement_amount,
    created_by
  ) values (
    source_expense.household_id,
    source_expense.title,
    source_expense.category,
    source_expense.description,
    target_reference_month,
    target_due_date,
    source_expense.amount,
    source_expense.estimated,
    source_expense.split_mode,
    case
      when source_expense.amount is null then 'planned'::public.expense_status
      else 'open'::public.expense_status
    end,
    'monthly'::public.recurrence_type,
    source_expense.series_id,
    source_expense.id,
    source_expense.has_reimbursement,
    source_expense.reimbursement_amount,
    source_expense.created_by
  )
  on conflict (household_id, series_id, reference_month)
    where series_id is not null
  do nothing
  returning id into created_expense_id;

  -- Outra execução pode ter criado a mesma competência em paralelo.
  if created_expense_id is null then
    return null;
  end if;

  insert into public.expense_shares (
    expense_id,
    member_id,
    amount,
    payment_status,
    reimbursement_status
  )
  select
    created_expense_id,
    source_share.member_id,
    source_share.amount,
    'pending'::public.share_status,
    case
      when source_expense.has_reimbursement then 'pending'
      else 'not_applicable'
    end
  from public.expense_shares source_share
  where source_share.expense_id = source_expense.id;

  if source_expense.has_reimbursement
    and exists (
      select 1
      from public.expense_shares created_share
      where created_share.expense_id = created_expense_id
    ) then
    insert into public.tasks (
      household_id,
      scope,
      title,
      description,
      due_date,
      source,
      source_expense_id,
      created_by
    ) values (
      source_expense.household_id,
      'geral'::public.task_scope,
      'Pedir reembolso: ' || source_expense.title,
      'Reembolso de R$ ' ||
        replace(
          to_char(
            coalesce(source_expense.reimbursement_amount, 0),
            'FM999999990.00'
          ),
          '.',
          ','
        ) ||
        ' por pessoa referente à despesa "' || source_expense.title || '".',
      target_due_date,
      'reimbursement',
      created_expense_id,
      source_expense.created_by
    );
  end if;

  return created_expense_id;
end;
$$;

revoke all on function public.create_recurring_expense_month(uuid, uuid, date)
  from public;
revoke all on function public.create_recurring_expense_month(uuid, uuid, date)
  from authenticated;
grant execute on function public.create_recurring_expense_month(uuid, uuid, date)
  to service_role;
