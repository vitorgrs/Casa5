-- Cadastro e edição atômicos de despesas e respectivos rateios.
-- Evita registros parciais quando uma das etapas falha ou a conexão cai.
-- Rode depois da 022_daily_chore_email_reminders.sql.

create or replace function public.save_expense_with_shares(
  target_expense_id uuid,
  expense_title text,
  expense_category text,
  expense_description text,
  expense_reference_month date,
  expense_due_date date,
  expense_amount numeric,
  expense_estimated boolean,
  expense_split_mode text,
  expense_recurrence text,
  expense_has_reimbursement boolean,
  expense_reimbursement_amount numeric,
  allow_share_mismatch boolean,
  share_values jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  acting_profile public.profiles%rowtype;
  saved_expense_id uuid;
  existing_series_id uuid;
  existing_amount numeric(12,2);
  existing_has_reimbursement boolean;
  existing_reimbursement_amount numeric(12,2);
  share_count integer := 0;
  distinct_member_count integer := 0;
  valid_member_count integer := 0;
  share_total numeric(12,2) := 0;
begin
  select * into acting_profile
  from public.profiles
  where id = auth.uid()
    and status = 'active'
    and household_id is not null;

  if acting_profile.id is null or not public.has_permission('manage_expenses') then
    raise exception 'Você não tem permissão para gerenciar despesas.';
  end if;

  expense_title := btrim(coalesce(expense_title, ''));
  expense_category := btrim(coalesce(expense_category, 'Outros'));
  expense_description := nullif(btrim(coalesce(expense_description, '')), '');
  share_values := coalesce(share_values, '[]'::jsonb);

  if expense_title = '' then
    raise exception 'Informe o nome da despesa.';
  end if;
  if expense_reference_month is null
    or extract(day from expense_reference_month) <> 1 then
    raise exception 'Informe um mês de referência válido.';
  end if;
  if expense_amount is not null and expense_amount < 0 then
    raise exception 'O valor da despesa não pode ser negativo.';
  end if;
  if expense_split_mode not in ('equal', 'custom') then
    raise exception 'Tipo de divisão inválido.';
  end if;
  if expense_recurrence not in ('once', 'monthly') then
    raise exception 'Recorrência inválida.';
  end if;
  if expense_has_reimbursement
    and (expense_reimbursement_amount is null
      or expense_reimbursement_amount <= 0) then
    raise exception 'Informe um valor de reembolso maior que zero.';
  end if;
  if jsonb_typeof(share_values) <> 'array' then
    raise exception 'Rateio inválido.';
  end if;

  begin
    select
      count(*)::integer,
      count(distinct (item->>'member_id'))::integer,
      coalesce(sum(round((item->>'amount')::numeric, 2)), 0)::numeric(12,2)
    into share_count, distinct_member_count, share_total
    from jsonb_array_elements(share_values) as values_list(item);
  exception when others then
    raise exception 'Há um valor inválido no rateio.';
  end;

  if share_count <> distinct_member_count then
    raise exception 'Cada morador só pode aparecer uma vez no rateio.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(share_values) as values_list(item)
    where (item->>'amount')::numeric < 0
  ) then
    raise exception 'Os valores do rateio não podem ser negativos.';
  end if;

  select count(*)::integer into valid_member_count
  from public.household_members member
  join jsonb_array_elements(share_values) as values_list(item)
    on member.id = (values_list.item->>'member_id')::uuid
  where member.household_id = acting_profile.household_id
    and member.active = true;

  if valid_member_count <> share_count then
    raise exception 'O rateio contém um morador inválido ou inativo.';
  end if;
  if expense_amount is null and share_count > 0 then
    raise exception 'Defina o valor total antes de criar o rateio.';
  end if;
  if coalesce(expense_amount, 0) > 0 and share_count = 0 then
    raise exception 'Selecione ao menos um morador para a divisão.';
  end if;
  if expense_amount is not null
    and (expense_split_mode <> 'custom' or not coalesce(allow_share_mismatch, false))
    and abs(share_total - round(expense_amount, 2)) > 0.01 then
    raise exception 'O rateio deve somar exatamente o valor da despesa.';
  end if;

  if target_expense_id is null then
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
      has_reimbursement,
      reimbursement_amount,
      created_by
    ) values (
      acting_profile.household_id,
      expense_title,
      coalesce(nullif(expense_category, ''), 'Outros'),
      expense_description,
      expense_reference_month,
      expense_due_date,
      expense_amount,
      coalesce(expense_estimated, false),
      expense_split_mode::public.split_mode,
      case when expense_amount is null
        then 'planned'::public.expense_status
        else 'open'::public.expense_status
      end,
      expense_recurrence::public.recurrence_type,
      case when expense_recurrence = 'monthly' then gen_random_uuid() else null end,
      coalesce(expense_has_reimbursement, false),
      case when expense_has_reimbursement then expense_reimbursement_amount else null end,
      acting_profile.id
    ) returning id into saved_expense_id;
  else
    select series_id, amount, has_reimbursement, reimbursement_amount
    into
      existing_series_id,
      existing_amount,
      existing_has_reimbursement,
      existing_reimbursement_amount
    from public.expenses
    where id = target_expense_id
      and household_id = acting_profile.household_id
    for update;

    if not found then
      raise exception 'Despesa não encontrada.';
    end if;

    if existing_amount is distinct from expense_amount and exists (
      select 1
      from public.expense_shares protected_share
      where protected_share.expense_id = target_expense_id
        and (
          protected_share.payment_status in (
            'paid'::public.share_status,
            'waived'::public.share_status
          )
          or protected_share.paid_amount is not null
          or protected_share.paid_at is not null
          or protected_share.receipt_path is not null
          or protected_share.reimbursement_status = 'paid'
        )
    ) then
      raise exception 'Não é possível alterar o valor total depois que existe pagamento, comprovante ou reembolso registrado.';
    end if;

    if exists (
      select 1
      from public.expense_shares reimbursed_share
      where reimbursed_share.expense_id = target_expense_id
        and reimbursed_share.reimbursement_status = 'paid'
    ) and (
      not coalesce(expense_has_reimbursement, false)
      or existing_has_reimbursement is distinct from expense_has_reimbursement
      or existing_reimbursement_amount is distinct from expense_reimbursement_amount
    ) then
      raise exception 'Não é possível desativar ou alterar um reembolso que já foi pago.';
    end if;

    update public.expenses
    set title = expense_title,
        category = coalesce(nullif(expense_category, ''), 'Outros'),
        description = expense_description,
        reference_month = expense_reference_month,
        due_date = expense_due_date,
        amount = expense_amount,
        estimated = coalesce(expense_estimated, false),
        split_mode = expense_split_mode::public.split_mode,
        -- O estado final é recalculado depois de atualizar as parcelas. Aqui
        -- preservamos o valor atual para não reabrir uma despesa já quitada.
        status = public.expenses.status,
        recurrence = expense_recurrence::public.recurrence_type,
        series_id = case
          when expense_recurrence = 'monthly'
            then coalesce(existing_series_id, gen_random_uuid())
          else existing_series_id
        end,
        has_reimbursement = coalesce(expense_has_reimbursement, false),
        reimbursement_amount = case
          when expense_has_reimbursement then expense_reimbursement_amount
          else null
        end
    where id = target_expense_id;

    saved_expense_id := target_expense_id;
  end if;

  if exists (
    select 1
    from public.expense_shares existing_share
    where existing_share.expense_id = saved_expense_id
      and not exists (
        select 1
        from jsonb_array_elements(share_values) as values_list(item)
        where (values_list.item->>'member_id')::uuid = existing_share.member_id
      )
      and (
        existing_share.payment_status in (
          'paid'::public.share_status,
          'waived'::public.share_status
        )
        or existing_share.paid_amount is not null
        or existing_share.paid_at is not null
        or existing_share.receipt_path is not null
        or existing_share.reimbursement_status = 'paid'
      )
  ) then
    raise exception 'Não é possível retirar do rateio um morador que já possui pagamento, comprovante ou reembolso registrado.';
  end if;

  if exists (
    select 1
    from public.expense_shares existing_share
    join jsonb_array_elements(share_values) as values_list(item)
      on (values_list.item->>'member_id')::uuid = existing_share.member_id
    where existing_share.expense_id = saved_expense_id
      and existing_share.amount is distinct from
        round((values_list.item->>'amount')::numeric, 2)
      and (
        existing_share.payment_status in (
          'paid'::public.share_status,
          'waived'::public.share_status
        )
        or existing_share.paid_amount is not null
        or existing_share.paid_at is not null
        or existing_share.receipt_path is not null
        or existing_share.reimbursement_status = 'paid'
      )
  ) then
    raise exception 'Não é possível alterar a parte de um morador que já possui pagamento, comprovante ou reembolso registrado.';
  end if;

  delete from public.expense_shares existing_share
  where existing_share.expense_id = saved_expense_id
    and not exists (
      select 1
      from jsonb_array_elements(share_values) as values_list(item)
      where (values_list.item->>'member_id')::uuid = existing_share.member_id
    );

  insert into public.expense_shares (
    expense_id,
    member_id,
    amount,
    reimbursement_status
  )
  select
    saved_expense_id,
    (values_list.item->>'member_id')::uuid,
    round((values_list.item->>'amount')::numeric, 2),
    case when expense_has_reimbursement then 'pending' else 'not_applicable' end
  from jsonb_array_elements(share_values) as values_list(item)
  on conflict (expense_id, member_id) do update
  set amount = excluded.amount,
      reimbursement_status = case
        when expense_has_reimbursement then
          case
            when expense_shares.reimbursement_status = 'not_applicable'
              then 'pending'
            else expense_shares.reimbursement_status
          end
        else 'not_applicable'
      end,
      reimbursement_paid_at = case
        when expense_has_reimbursement then expense_shares.reimbursement_paid_at
        else null
      end;

  update public.expenses saved_expense
  set status = case
    when expense_amount is null then 'planned'::public.expense_status
    when share_count > 0 and not exists (
      select 1
      from public.expense_shares current_share
      where current_share.expense_id = saved_expense_id
        and current_share.payment_status not in (
          'paid'::public.share_status,
          'waived'::public.share_status
        )
    ) then 'paid'::public.expense_status
    else 'open'::public.expense_status
  end
  where saved_expense.id = saved_expense_id;

  if expense_has_reimbursement and share_count > 0 then
    update public.tasks
    set title = 'Pedir reembolso: ' || expense_title,
        description = 'Reembolso de R$ ' ||
          replace(to_char(coalesce(expense_reimbursement_amount, 0), 'FM999999990.00'), '.', ',') ||
          ' por pessoa referente à despesa "' || expense_title || '".',
        due_date = expense_due_date,
        updated_at = now()
    where household_id = acting_profile.household_id
      and source = 'reimbursement'
      and source_expense_id = saved_expense_id;

    if not found then
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
        acting_profile.household_id,
        'geral'::public.task_scope,
        'Pedir reembolso: ' || expense_title,
        'Reembolso de R$ ' ||
          replace(to_char(coalesce(expense_reimbursement_amount, 0), 'FM999999990.00'), '.', ',') ||
          ' por pessoa referente à despesa "' || expense_title || '".',
        expense_due_date,
        'reimbursement',
        saved_expense_id,
        acting_profile.id
      );
    end if;
  else
    delete from public.tasks
    where household_id = acting_profile.household_id
      and source = 'reimbursement'
      and source_expense_id = saved_expense_id;
  end if;

  return saved_expense_id;
end;
$$;

revoke all on function public.save_expense_with_shares(
  uuid, text, text, text, date, date, numeric, boolean, text, text,
  boolean, numeric, boolean, jsonb
) from public;
grant execute on function public.save_expense_with_shares(
  uuid, text, text, text, date, date, numeric, boolean, text, text,
  boolean, numeric, boolean, jsonb
) to authenticated;
